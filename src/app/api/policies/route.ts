import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { db, policies, executions, policyGroups, users } from '@/lib/prisma';
import { getPlanLimit, isUnlimited, PlanType, PLANS } from '@/lib/plans';
import { upgradeResponse, UPGRADE_HTTP_STATUS } from '@/lib/plan-quota';
import { detectPII } from '@/services/pii/detector';
import { getPolicyFreezeStatus } from '@/lib/policy-freeze';
import { checkTeamPermission, TeamPermission } from '@/lib/team-permissions';
import {
  createVersion,
  assertCompilable,
  PolicyCompileError,
} from '@/services/policy/version-manager';
import { makeCompileValidator } from '@/lib/policy-compile-validator';
import { compileGateErrorResponse } from '@/lib/policy-compile-response';
import {
  buildAliasReservedForUser,
  getStructuralAliasGrant,
} from '@/lib/structural-alias-grants';
import { errorEnvelope } from '@/lib/api/error-envelope';
import { invalidatePolicyCache } from '@/lib/cache';
import { eq, isNull, desc, sql, and, inArray } from 'drizzle-orm';

// GET /api/policies - List user's policies
export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const [policiesData, freezeStatus] = await Promise.all([
      db.query.policies.findMany({
        where: and(eq(policies.userId, session.user.id), isNull(policies.deletedAt)),
        orderBy: [desc(policies.updatedAt)],
        with: {
          group: {
            columns: {
              id: true,
              name: true,
              icon: true,
              parentId: true,
            },
          },
        },
      }),
      getPolicyFreezeStatus(session.user.id),
    ]);

    // 单次查询获取所有 policy 的执行次数
    const policyIds = policiesData.map((p) => p.id);
    const executionCounts: Record<string, number> = {};
    if (policyIds.length > 0) {
      const counts = await db
        .select({
          policyId: executions.policyId,
          count: sql<number>`count(*)::int`,
        })
        .from(executions)
        .where(inArray(executions.policyId, policyIds))
        .groupBy(executions.policyId);
      for (const row of counts) {
        executionCounts[row.policyId] = row.count;
      }
    }
    const policiesWithCount = policiesData.map((policy) => ({
      ...policy,
      _count: { executions: executionCounts[policy.id] ?? 0 },
    }));

    // 添加冻结状态到每个策略
    const policiesWithFreeze = policiesWithCount.map((policy) => ({
      ...policy,
      isFrozen: freezeStatus.frozenPolicyIds.has(policy.id),
    }));

    return NextResponse.json({
      policies: policiesWithFreeze,
      freezeInfo: {
        limit: freezeStatus.limit,
        total: freezeStatus.totalPolicies,
        frozenCount: freezeStatus.frozenCount,
      },
    });
  } catch (error) {
    console.error('Error fetching policies:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/policies - Create a new policy
export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { name, content, description, isPublic, groupId, teamId, aliasSet, locale } =
      await req.json();

    if (!name || !content) {
      return NextResponse.json(
        { error: 'Name and content are required' },
        { status: 400 }
      );
    }

    // When teamId is provided, verify the caller has POLICY_CREATE on
    // that team. This consolidates "create policy under a team" into
    // the same endpoint as personal policies — the team-specific
    // /api/teams/[teamId]/policies route stays available for compat
    // but new UI uses ?teamId= on /policies/new.
    if (teamId) {
      if (typeof teamId !== 'string') {
        return NextResponse.json(
          { error: 'teamId must be a string' },
          { status: 400 }
        );
      }
      const perm = await checkTeamPermission(
        session.user.id,
        teamId,
        TeamPermission.POLICY_CREATE,
      );
      if (!perm.allowed) {
        return NextResponse.json(
          { error: perm.error ?? 'Forbidden' },
          { status: perm.status ?? 403 },
        );
      }
    }

    // 如果指定了分组，验证分组存在且用户有权限
    if (groupId) {
      // 简化查询：先查询用户的分组，再查询团队分组
      let group = await db.query.policyGroups.findFirst({
        where: and(
          eq(policyGroups.id, groupId),
          eq(policyGroups.userId, session.user.id)
        ),
      });

      // 如果不是用户的分组，检查是否是团队成员可访问的分组
      if (!group) {
        // TODO: 需要复杂查询，暂时简化为仅检查用户自己的分组
        // 完整实现需要检查 team.members
        return NextResponse.json({ error: 'Group not found' }, { status: 404 });
      }
    }

    // Check policy limit for free users
    const user = await db.query.users.findFirst({
      where: eq(users.id, session.user.id),
      columns: { plan: true, trialEndsAt: true },
    });

    if (user) {
      const plan = (user.plan && user.plan in PLANS ? user.plan : 'free') as PlanType;
      const trialExpired =
        plan === 'trial' && user.trialEndsAt && user.trialEndsAt < new Date();
      const effectivePlan = trialExpired ? 'free' : plan;

      if (trialExpired) {
        await db.update(users).set({ plan: 'free' }).where(eq(users.id, session.user.id));
      }

      const policyLimit = getPlanLimit(effectivePlan, 'policies');
      const [{ count: policyCount }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(policies)
        .where(and(eq(policies.userId, session.user.id), isNull(policies.deletedAt)));

      if (!isUnlimited(policyLimit) && policyCount >= policyLimit) {
        return NextResponse.json(
          upgradeResponse('published_rules', {
            usage: policyCount,
            limit: policyLimit,
            message: `Current plan allows ${policyLimit} policies. Upgrade for higher limits.`,
          }),
          { status: UPGRADE_HTTP_STATUS }
        );
      }
    }

    const piiResult = detectPII(content);

    // Build insert values, only include groupId if it's a valid non-empty string
    const policyId = globalThis.crypto.randomUUID();

    // Log the values for debugging
    const piiFieldsValue = piiResult.detectedTypes.length > 0 ? piiResult.detectedTypes : null;
    const now = new Date();
    console.log('Insert values:', {
      id: policyId,
      userId: session.user.id,
      name,
      description: description || null,
      isPublic: isPublic || false,
      piiFields: piiFieldsValue,
      groupId: groupId || null,
      createdAt: now,
      updatedAt: now,
    });
    const insertValues: {
      id: string;
      userId: string;
      name: string;
      content: string;
      description?: string | null;
      isPublic: boolean;
      piiFields?: string[] | null;
      groupId?: string | null;
      teamId?: string | null;
      createdAt: Date;
      updatedAt: Date;
    } = {
      id: policyId,
      userId: session.user.id,
      name,
      content,
      description: description || null,
      isPublic: isPublic || false,
      createdAt: now,
      updatedAt: now,
    };

    // Only add piiFields if there are detected types
    if (piiResult.detectedTypes.length > 0) {
      insertValues.piiFields = piiResult.detectedTypes;
    }

    // Only add groupId if it's a valid UUID string
    if (groupId && typeof groupId === 'string' && groupId.trim() !== '') {
      insertValues.groupId = groupId;
    }

    // Team ownership — already permission-checked above.
    if (teamId && typeof teamId === 'string') {
      insertValues.teamId = teamId;
    }

    // Test raw SQL to see if connection works
    try {
      const testResult = await db.execute(sql`SELECT 1 as test`);
      console.log('DB connection test:', testResult);
    } catch (connErr) {
      console.error('DB connection test failed:', connErr);
      throw new Error(`Database connection failed: ${connErr instanceof Error ? connErr.message : String(connErr)}`);
    }

    const aliasSetInput =
      aliasSet &&
      typeof aliasSet === 'object' &&
      !Array.isArray(aliasSet) &&
      Object.keys(aliasSet as Record<string, unknown>).length > 0
        ? (aliasSet as Record<string, string[]>)
        : null;
    const compileLocale = typeof locale === 'string' && locale.trim()
      ? locale
      : 'en-US';
    const allowStructural = await getStructuralAliasGrant(session.user.id);
    const aliasReserved = aliasSetInput
      ? await buildAliasReservedForUser(session.user.id, compileLocale)
      : undefined;

    // 编译门禁在开启事务**之前** preflight——避免事务内网络调用（慢/超时会持锁
    // + 挂着已插入行等 30s）。有 error 诊断抛 PolicyCompileError → 下方 catch 转 400（检查不可用时 503）。
    await assertCompilable(makeCompileValidator(session.user.id), {
      source: content,
      locale: compileLocale,
      aliasSet: aliasSetInput,
    });

    const policy = await db.transaction(async (tx) => {
      const result = await tx
        .insert(policies)
        .values(insertValues)
        .returning();
      const createdPolicy = result[0];
      console.log('Policy insert succeeded:', createdPolicy.id);
      await createVersion({
        policyId: createdPolicy.id,
        source: content,
        createdBy: session.user.id,
        releaseNote: 'Initial version',
        locale: compileLocale,
        aliasSet: aliasSetInput,
        aliasReserved,
        allowStructuralAliases: allowStructural,
        dbClient: tx,
      });
      console.log('PolicyVersion insert succeeded');
      return createdPolicy;
    });
    // 缓存失效在提交后执行（createVersion 在事务内不做）。
    await invalidatePolicyCache(policy.id);

    return NextResponse.json(policy, { status: 201 });
  } catch (error: unknown) {
    // 编译门禁拒绝：源码有阻断诊断 → 400；编译检查暂不可用 → 503 可重试。
    if (error instanceof PolicyCompileError) {
      return compileGateErrorResponse(error);
    }
    // aliasSet 校验失败是用户可修正的输入错误（4xx）——回显校验信息本就是给用户看的，
    // 不含内部实现细节，保留 400 分支。
    if (
      error instanceof Error &&
      (error.message.includes('用户自定义别名校验失败') ||
        error.message.includes('aliasSet 非空'))
    ) {
      return NextResponse.json(
        { error: 'Invalid aliasSet', message: error.message },
        { status: 400 },
      );
    }
    // H2 信息泄露修复：此前 500 把 error.stack + postgres 的 detail/hint/constraint/
    // table/column + 全部 error keys 直接回给客户端（schema/约束/内部路径外泄）。
    // 改为：完整细节只进服务端日志并以 requestId 关联，响应仅含稳定 code + requestId
    // （用户报障时给 requestId 即可定位）。用统一 errorEnvelope，与全站 4xx/5xx 契约一致。
    const requestId = crypto.randomUUID();
    const err = error as Record<string, unknown>;
    console.error(`[policies:create] requestId=${requestId}`, {
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : typeof error,
      stack: error instanceof Error ? error.stack : undefined,
      pgCode: err?.code,
      constraint: err?.constraint,
      table: err?.table,
      column: err?.column,
      detail: err?.detail,
    });
    return errorEnvelope({
      status: 500,
      code: 'internal_error',
      message: 'Failed to create policy. Provide this request id when reporting the issue.',
      requestId,
    });
  }
}
