import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { db, policies, policyVersions, executions, policyGroups } from '@/lib/prisma';
import { eq, and, isNull, desc, sql } from 'drizzle-orm';
import { detectPII } from '@/services/pii/detector';
import {
  createVersion,
  assertCompilable,
  PolicyCompileError,
} from '@/services/policy/version-manager';
import { makeCompileValidator } from '@/lib/policy-compile-validator';
import { compileGateErrorResponse } from '@/lib/policy-compile-response';
import { getStructuralAliasGrant, buildAliasReservedForUser } from '@/lib/structural-alias-grants';
import { canonicalAliasJson } from '@/lib/policy-alias';
import { isPolicyFrozen } from '@/lib/policy-freeze';
import { softDeletePolicy } from '@/lib/policy-lifecycle';
import { invalidatePolicyCache } from '@/lib/cache';


interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/policies/[id] - Get a single policy
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    // 先查用户自己的策略或公开策略
    let policy = await db.query.policies.findFirst({
      where: and(
        eq(policies.id, id),
        isNull(policies.deletedAt),
        sql`(${policies.userId} = ${session.user.id} OR ${policies.isPublic} = true)`
      ),
    });

    // 如果不是用户自己的策略,检查是否是团队策略
    if (!policy || (policy.userId !== session.user.id && !policy.isPublic)) {
      const teamPolicy = await db.query.policies.findFirst({
        where: and(
          eq(policies.id, id),
          isNull(policies.deletedAt)
        ),
        with: {
          team: {
            with: {
              members: true,
            },
          },
        },
      });

      if (teamPolicy?.team?.members.some(m => m.userId === session.user.id)) {
        policy = teamPolicy;
      }

      // Final fallback: the policy was shared with one of the
      // caller's teams via PolicyShare. Only consult when sharing
      // is platform-enabled — flag off → shares are dormant data,
      // not access grants.
      if (!policy && teamPolicy) {
        const { isPolicySharingEnabled } = await import(
          '@/lib/platform-settings'
        );
        if (await isPolicySharingEnabled()) {
          const sharedRows = (await db.execute(sql`
            SELECT 1 AS ok
            FROM "PolicyShare" ps
            JOIN "TeamMember" tm ON tm."teamId" = ps."teamId"
            WHERE ps."policyId" = ${id}
              AND tm."userId" = ${session.user.id}
            LIMIT 1
          `)) as unknown as Array<{ ok: number }>;
          if (sharedRows.length > 0) {
            policy = teamPolicy;
          }
        }
      }
    }

    if (!policy) {
      return NextResponse.json({ error: 'Policy not found' }, { status: 404 });
    }

    // 获取版本列表
    const versions = await db.query.policyVersions.findMany({
      where: eq(policyVersions.policyId, id),
      orderBy: desc(policyVersions.version),
      limit: 10,
    });

    // 活跃版本（version === Policy.version，与 content 同源）冻结的 aliasSet（canonical JSON）。
    // 精确查一次而非让客户端从上面的 latest-10 versions 里推断——rollback/set-default 可能把
    // 活跃版本切到旧版本（不在前 10 内），客户端推断会漏。执行页据此合并 lexicon 提取 schema
    // （否则含关键词/运算符别名的源码在「生成示例」阶段解析失败）。口径同执行路径（C1 SQL JOIN）。
    const activeVersion = await db.query.policyVersions.findFirst({
      where: and(eq(policyVersions.policyId, id), eq(policyVersions.version, policy.version)),
      columns: { aliasSet: true },
    });

    // 获取执行次数
    const [{ count: executionCount }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(executions)
      .where(eq(executions.policyId, id));

    // 检查策略是否被冻结（只对策略所有者检查）
    let freezeInfo = null;
    if (policy.userId === session.user.id) {
      freezeInfo = await isPolicyFrozen(session.user.id, id);
    }

    return NextResponse.json({
      ...policy,
      versions,
      // 活跃版本冻结别名（canonical JSON 字符串或 null）。前端合并进 lexicon 供 schema 提取。
      activeAliasSet: activeVersion?.aliasSet ?? null,
      _count: { executions: executionCount },
      isFrozen: freezeInfo?.isFrozen ?? false,
      freezeInfo: freezeInfo
        ? {
            reason: freezeInfo.reason,
            limit: freezeInfo.activePoliciesLimit,
            total: freezeInfo.totalPolicies,
            frozenCount: freezeInfo.frozenCount,
          }
        : null,
    });
  } catch (error) {
    console.error('Error fetching policy:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PUT /api/policies/[id] - Update a policy
export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const { name, content, description, isPublic, groupId, aliasSet, locale } = await req.json();

    // Check ownership (exclude deleted policies)
    const existingPolicy = await db.query.policies.findFirst({
      where: and(
        eq(policies.id, id),
        eq(policies.userId, session.user.id),
        isNull(policies.deletedAt)
      ),
    });

    if (!existingPolicy) {
      return NextResponse.json({ error: 'Policy not found' }, { status: 404 });
    }

    // 检查策略是否被冻结
    const freezeInfo = await isPolicyFrozen(session.user.id, id);
    if (freezeInfo.isFrozen) {
      return NextResponse.json(
        {
          error: 'Policy is frozen',
          message: `This policy is frozen because your plan allows ${freezeInfo.activePoliciesLimit} policies but you have ${freezeInfo.totalPolicies}. Delete some policies or upgrade your plan.`,
          frozen: true,
        },
        { status: 403 }
      );
    }

    // C2：新版本必须走 version-manager（校验别名 + canonical + envelope 冻结 + 审计），
    // 不能裸插 policyVersions（此前编辑路径丢弃 aliasSet、无 envelope/审计/事务）。
    // aliasSet 从 body 取；allowStructural 从服务端 per-user entitlement 权威取（不信前端）；
    // 事务包 update + createVersion 防不一致。null/空 aliasSet 行为不变。
    // ★Policy.version 由 createVersion 计算的版本号回填，保证 Policy.version ==
    //   PolicyVersion.version（执行路径 C1 靠此 JOIN 取活跃版本的冻结 aliasSet）。
    // 提交的别名字段。★区分三态（High 修复：省略字段不得清空已有别名）：
    //   - 字段缺省(undefined) → 保留活跃版本的现有别名（不改）
    //   - null / {} / 数组 → 显式清空
    //   - 非空对象 → 采用之
    const requestHasAliasField = aliasSet !== undefined;
    const submittedAliasSet =
      aliasSet &&
      typeof aliasSet === 'object' &&
      !Array.isArray(aliasSet) &&
      Object.keys(aliasSet as Record<string, unknown>).length > 0
        ? (aliasSet as Record<string, string[]>)
        : null;
    const compileLocale = typeof locale === 'string' && locale.trim() ? locale : 'en-US';

    // 取活跃版本冻结的别名（canonical JSON）：字段缺省时作保留值 + content-only 变更时
    // 沿用它进新版本 + 判断 aliasChanged 的对照基线。仅在有版本编译输入变动时才需要，
    // 但 content 变或字段存在都可能触发，故统一先取一次。
    const activeVersion = await db.query.policyVersions.findFirst({
      where: and(
        eq(policyVersions.policyId, id),
        eq(policyVersions.version, existingPolicy.version),
      ),
      columns: { aliasSet: true },
    });
    const existingCanonical = activeVersion?.aliasSet ?? null;
    let existingAliasSet: Record<string, string[]> | null = null;
    if (existingCanonical) {
      try {
        existingAliasSet = JSON.parse(existingCanonical) as Record<string, string[]>;
      } catch {
        existingAliasSet = null;
      }
    }

    // effective 别名：字段存在用提交值（含显式清空），否则保留现有。
    const aliasSetInput = requestHasAliasField ? submittedAliasSet : existingAliasSet;

    // 是否需要建新版本：content 变 **或** aliasSet 变（二者都是版本编译输入并进 envelope，
    // 任一变则旧版本快照失真）。aliasSet 变化用 canonical JSON 比较（对齐 envelope 冻结口径，
    // 键序/别名序等表面差异不误触发）。审计缺口修复：此前只看 content，别名单独变会被静默丢弃。
    const contentChanged = content !== undefined && content !== existingPolicy.content;
    // 只有字段存在时别名才可能变；缺省=保留现有，恒不算变。
    const aliasChanged =
      requestHasAliasField && existingCanonical !== canonicalAliasJson(submittedAliasSet);
    const newVersion = contentChanged || aliasChanged;
    // 新版本的源码：content 提交则用之，否则沿用现有 content（alias-only 变更不改源码）。
    const versionSource = content !== undefined ? content : existingPolicy.content;

    const piiResult = newVersion ? detectPII(versionSource) : null;

    // Build update data
    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData.name = name;
    if (content !== undefined) updateData.content = content;
    if (description !== undefined) updateData.description = description;
    if (isPublic !== undefined) updateData.isPublic = isPublic;
    // ★ 移动到分组时必须校验目标分组归属 —— 与 POST /api/policies 保持一致。
    //   此前 PUT 未校验：攻击者可把自己的策略的 groupId 指向受害者的分组。
    //   危害不止于"挂错位置"：DELETE /api/policy-groups/[id] 的级联按 groupId
    //   改写策略且**无 owner 谓词**，受害者（或团队管理员）删除分组时会连带
    //   改写其他用户拥有的行。
    if (groupId) {
      const targetGroup = await db.query.policyGroups.findFirst({
        where: and(
          eq(policyGroups.id, groupId),
          eq(policyGroups.userId, session.user.id)
        ),
        columns: { id: true },
      });
      if (!targetGroup) {
        return NextResponse.json({ error: 'Group not found' }, { status: 404 });
      }
    }
    if (groupId !== undefined) updateData.groupId = groupId || null;

    if (newVersion) {
      updateData.piiFields = piiResult?.detectedTypes;
    }

    // 只有新建版本（源码变更）才编译校验；在事务外 preflight（避免事务内网络调用）。
    // 用与 createVersion 一致的 aliasSetInput（effective 别名）编译，避免语义分裂。
    // 有 error 诊断抛 PolicyCompileError → 下方 catch 转 400（检查不可用时 503）。
    if (newVersion) {
      await assertCompilable(makeCompileValidator(session.user.id), {
        source: versionSource,
        locale: compileLocale,
        aliasSet: aliasSetInput,
      });
    }

    // allowStructural 来源：
    //   - 别名有变（aliasChanged）→ 按当前 per-user 授权权威判定（新引入的别名须现授权）。
    //   - 别名沿用活跃版本（!aliasChanged，如 content-only 编辑）→ 视为已授权：这些别名在
    //     原版本创建时已授权+校验+冻结，授权撤销不得阻断对已有策略的后续（非别名）编辑，
    //     与执行端「冻结即信任」同口径。避免撤销授权后合法用户改不了源码。
    // 两项读取放在事务外：事务内经全局 db 读要第二条连接，池满时与事务互等。
    const allowStructural = aliasChanged
      ? await getStructuralAliasGrant(session.user.id)
      : true;
    const aliasReserved = newVersion && aliasSetInput
      ? await buildAliasReservedForUser(session.user.id, compileLocale)
      : undefined;

    const policy = await db.transaction(async (tx) => {
      if (newVersion) {
        const createdVersion = await createVersion({
          policyId: id,
          source: versionSource,
          createdBy: session.user.id,
          releaseNote: 'Edited version',
          locale: compileLocale,
          aliasSet: aliasSetInput,
          aliasReserved,
          allowStructuralAliases: allowStructural,
          dbClient: tx,
        });
        updateData.version = createdVersion.version; // 回填，保持 Policy.version ↔ PolicyVersion.version 一致
      }
      const [updated] = await tx
        .update(policies)
        .set(updateData)
        .where(eq(policies.id, id))
        .returning();
      return updated;
    });

    // 失效策略缓存（异步，不阻塞响应）
    invalidatePolicyCache(id).catch(err =>
      console.warn('[Cache] Failed to invalidate policy cache:', err)
    );

    return NextResponse.json(policy);
  } catch (error) {
    // 编译门禁拒绝：源码有阻断诊断 → 400；编译检查暂不可用 → 503 可重试。
    if (error instanceof PolicyCompileError) {
      return compileGateErrorResponse(error);
    }
    console.error('Error updating policy:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/policies/[id] - Soft delete a policy (move to trash)
export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    // 解析可选的删除原因
    let reason: string | undefined;
    try {
      const body = await req.json();
      reason = body?.reason;
    } catch {
      // 无请求体，忽略
    }

    // 使用软删除
    const result = await softDeletePolicy(id, session.user.id, reason);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 404 });
    }

    // 失效策略缓存（异步，不阻塞响应）
    invalidatePolicyCache(id).catch(err =>
      console.warn('[Cache] Failed to invalidate policy cache:', err)
    );

    return NextResponse.json({
      success: true,
      message: 'Policy moved to trash. It will be permanently deleted after 30 days.',
    });
  } catch (error) {
    console.error('Error deleting policy:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
