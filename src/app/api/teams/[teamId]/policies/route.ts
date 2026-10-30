import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { db, policies, executions } from '@/lib/prisma';
import { and, eq, desc, isNull, sql } from 'drizzle-orm';
import { loadPolicyForAction } from '@/lib/policy-access';
import { invalidatePolicyCache } from '@/lib/cache';
import { checkTeamPermission, TeamPermission } from '@/lib/team-permissions';
import { assertCompilable, createVersion, PolicyCompileError } from '@/services/policy/version-manager';
import { invalidatePolicyCache } from '@/lib/cache';
import { loadSaveVocabulary, makeCompileValidator } from '@/lib/policy-compile-validator';
import { compileGateErrorResponse, vocabularyScopeInvalidResponse } from '@/lib/policy-compile-response';


type RouteParams = { params: Promise<{ teamId: string }> };

// GET /api/teams/[teamId]/policies - 列出团队策略
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized', code: 'unauthorized' }, { status: 401 });
    }

    const { teamId } = await params;

    // 检查查看策略的权限
    const permission = await checkTeamPermission(
      session.user.id,
      teamId,
      TeamPermission.POLICY_VIEW
    );
    if (!permission.allowed) {
      return NextResponse.json({ error: permission.error, code: permission.code }, { status: permission.status });
    }

    // 回收站里的策略不列出（与 GET /api/teams/[teamId] 的 policyCount 同一口径，#674）
    const teamPolicies = await db.query.policies.findMany({
      where: and(eq(policies.teamId, teamId), isNull(policies.deletedAt)),
      with: {
        user: {
          columns: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
      orderBy: desc(policies.updatedAt),
    });

    // 并行获取每个策略的执行次数
    const policiesWithCounts = await Promise.all(
      teamPolicies.map(async (policy) => {
        const [executionCountResult] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(executions)
          .where(eq(executions.policyId, policy.id));

        return {
          id: policy.id,
          name: policy.name,
          description: policy.description,
          version: policy.version,
          piiFields: policy.piiFields,
          createdBy: policy.user
            ? {
                id: policy.user.id,
                name: policy.user.name,
                email: policy.user.email,
              }
            : null,
          executionCount: executionCountResult.count,
          createdAt: policy.createdAt.toISOString(),
          updatedAt: policy.updatedAt.toISOString(),
        };
      })
    );

    return NextResponse.json({
      policies: policiesWithCounts,
    });
  } catch (error) {
    console.error('Error listing team policies:', error);
    return NextResponse.json({ error: 'Internal server error.', code: 'internal_server_error' }, { status: 500 });
  }
}

// POST /api/teams/[teamId]/policies - 分配策略到团队或创建新策略
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized', code: 'unauthorized' }, { status: 401 });
    }

    const { teamId } = await params;

    // 检查创建策略的权限
    const permission = await checkTeamPermission(
      session.user.id,
      teamId,
      TeamPermission.POLICY_CREATE
    );
    if (!permission.allowed) {
      return NextResponse.json({ error: permission.error, code: permission.code }, { status: permission.status });
    }

    const { policyId, name, content, description } = await req.json();

    // 如果提供了 policyId，将现有策略分配给团队
    if (policyId) {
      // 只允许把本人的个人策略（未删除）导入团队：已属于团队的策略不能被「再导入」到另一个团队，
      // 他人的个人策略按不存在处理，防止未经授权泄露策略内容
      const access = await loadPolicyForAction(policyId, { userId: session.user.id }, 'update');
      if (!access.ok || access.policy.teamId) {
        return NextResponse.json(
          { error: 'Policy not found or already assigned to another team.', code: 'policy_unavailable' },
          { status: 404 }
        );
      }

      // 分配策略到团队
      const [updatedPolicy] = await db
        .update(policies)
        .set({ teamId })
        .where(eq(policies.id, policyId))
        .returning();

      if (!updatedPolicy) {
        throw new Error('Failed to update policy');
      }
      // 执行路径缓存了策略元数据（含 teamId）：归属变了必须失效，否则授权按旧归属判定
      await invalidatePolicyCache(policyId).catch((err) => console.warn('[Cache] Failed to invalidate policy cache:', err));

      return NextResponse.json({
        id: updatedPolicy.id,
        name: updatedPolicy.name,
        teamId: updatedPolicy.teamId,
      });
    }

    // 否则，创建新的团队策略
    if (!name || typeof name !== 'string' || name.length < 1) {
      return NextResponse.json({ error: 'Policy name is required.', code: 'policy_name_required' }, { status: 400 });
    }

    if (!content || typeof content !== 'string') {
      return NextResponse.json({ error: 'Policy content is required.', code: 'policy_content_required' }, { status: 400 });
    }

    // ★编译门禁：与 /api/policies 和 /api/v1/.../versions 保持一致。
    //   此入口此前无门禁——不可解析的源码能落库，直到**执行时**才报语法错。
    //   实测事故：AI 生成的 `is < 18`（is 后接符号）由此入口存入，
    //   用户在执行页才看到「行 15 第 25 列」的报错。
    //   放在插入**之前**（事务外）：避免事务内网络调用持锁。
    const saveVocabulary = await loadSaveVocabulary(session.user.id, { source: content, locale: 'en-US' });
    const profile = await assertCompilable(makeCompileValidator(session.user.id, saveVocabulary.vocabulary), {
      source: content,
      locale: 'en-US',
      aliasSet: null,
    });

    // 策略行与 v1 版本行同一事务写入，与 /api/policies 一致（#681：此前只建策略行，
    // 版本列表为空、提交审批 400，而详情页仍显示 v1）
    const newPolicyId = globalThis.crypto.randomUUID();
    const newPolicy = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(policies)
        .values({
          id: newPolicyId,
          name,
          content,
          description: description || null,
          userId: session.user.id,
          teamId,
        })
        .returning();
      if (!inserted) {
        throw new Error('Failed to create policy');
      }
      await createVersion({
        policyId: inserted.id,
        source: content,
        createdBy: session.user.id,
        releaseNote: undefined,
        locale: 'en-US',
        scopesJson: saveVocabulary.scopesJson,
        aliasSet: null,
        profile,
        dbClient: tx,
      });
      return inserted;
    });
    await invalidatePolicyCache(newPolicy.id).catch((err) => console.warn('[Cache] Failed to invalidate policy cache:', err));

    return NextResponse.json(
      {
        id: newPolicy.id,
        name: newPolicy.name,
        description: newPolicy.description,
        teamId: newPolicy.teamId,
        createdAt: newPolicy.createdAt.toISOString(),
      },
      { status: 201 }
    );
  } catch (error: unknown) {
    // 编译门禁拒绝：源码有阻断诊断 → 400；编译检查暂不可用 → 503 可重试。
    if (error instanceof PolicyCompileError) {
      return compileGateErrorResponse(error);
    }
    const vocabularyInvalid = vocabularyScopeInvalidResponse(error);
    if (vocabularyInvalid) return vocabularyInvalid;
    console.error('Error creating team policy:', error);
    return NextResponse.json({ error: 'Internal server error.', code: 'internal_server_error' }, { status: 500 });
  }
}
