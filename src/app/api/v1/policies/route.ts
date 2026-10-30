import { NextResponse } from 'next/server';
import { authenticateApiRequest } from '@/lib/api-keys';
import { db, policies, executions } from '@/lib/prisma';
import { eq, and, isNull, desc, sql, inArray } from 'drizzle-orm';
import { isPersonalPolicy, teamsAllowing } from '@/lib/policy-access';
import { checkUsageLimit, recordUsage } from '@/lib/usage';
import { getPolicyFreezeStatus, getBatchPolicyFreezeStatus } from '@/lib/policy-freeze';
import { upgradeResponse } from '@/lib/plan-quota';

// GET /api/v1/policies - List user's policies via API
export async function GET(req: Request) {
  try {
    const auth = await authenticateApiRequest(req);
    if (!auth.success) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const { userId, teamId: keyTeamId, quotaOwnerId } = auth;

    // API 调用配额按 key 的配额 owner 计（团队 key 为团队 owner，个人 key 为持有者本人，ADR 0015 §10），
    // 否则 Free 成员持团队 key 调列表会被自己的 0 额度拦下（#671）。
    const apiLimitCheck = await checkUsageLimit(quotaOwnerId, 'api_call');
    if (!apiLimitCheck.allowed) {
      return NextResponse.json(
        upgradeResponse('evaluations', { message: apiLimitCheck.message }),
        { status: 429 }
      );
    }

    // 个人策略：只有个人 key 列出持有者本人的个人策略；团队 key 不越出团队（#671）。
    const ownPolicies = keyTeamId
      ? []
      : await db.query.policies.findMany({
          where: and(eq(policies.userId, userId), isPersonalPolicy(), isNull(policies.deletedAt)),
          orderBy: desc(policies.updatedAt),
          columns: {
            id: true,
            name: true,
            description: true,
            isPublic: true,
            createdAt: true,
            updatedAt: true,
          },
        });

    // 团队策略：持有者当前可查看的团队（团队 key 只取其所属团队），含本人创建的团队策略。
    const visibleTeams = teamsAllowing(userId, 'view');
    const teamPolicies = await db.query.policies.findMany({
      where: and(
        isNull(policies.deletedAt),
        inArray(policies.teamId, visibleTeams),
        ...(keyTeamId ? [eq(policies.teamId, keyTeamId)] : []),
      ),
      orderBy: desc(policies.updatedAt),
      columns: {
        id: true,
        name: true,
        description: true,
        isPublic: true,
        createdAt: true,
        updatedAt: true,
        userId: true,
        teamId: true,
      },
      with: {
        team: {
          columns: {
            id: true,
            name: true,
          },
        },
      },
    });

    // 获取冻结状态
    const freezeStatus = await getPolicyFreezeStatus(userId);

    // 获取团队策略所有者的冻结状态（批量查询优化，避免 N+1 问题）
    const ownerIds = [...new Set(teamPolicies.map((p) => p.userId))];
    const ownerFreezeMap = await getBatchPolicyFreezeStatus(ownerIds);

    // 获取每个策略的执行次数
    const ownPoliciesWithCount = await Promise.all(
      ownPolicies.map(async (policy) => {
        const [{ count }] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(executions)
          .where(eq(executions.policyId, policy.id));

        return {
          id: policy.id,
          name: policy.name,
          description: policy.description,
          isPublic: policy.isPublic,
          isFrozen: freezeStatus.frozenPolicyIds.has(policy.id),
          executionCount: count,
          createdAt: policy.createdAt.toISOString(),
          updatedAt: policy.updatedAt.toISOString(),
          source: 'own' as const,
        };
      })
    );

    const teamPoliciesWithInfo = await Promise.all(
      teamPolicies.map(async (policy) => {
        const [{ count }] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(executions)
          .where(eq(executions.policyId, policy.id));

        // 根据策略所有者的冻结状态判断
        const ownerFrozenIds = ownerFreezeMap.get(policy.userId) || new Set();
        return {
          id: policy.id,
          name: policy.name,
          description: policy.description,
          isPublic: policy.isPublic,
          isFrozen: ownerFrozenIds.has(policy.id),
          executionCount: count,
          createdAt: policy.createdAt.toISOString(),
          updatedAt: policy.updatedAt.toISOString(),
          source: 'team' as const,
          teamId: policy.teamId,
          teamName: policy.team?.name,
        };
      })
    );

    const policiesWithFreeze = [...ownPoliciesWithCount, ...teamPoliciesWithInfo];

    // 记录 API 调用（与上方配额检查同一归属）
    await recordUsage(quotaOwnerId, 'api_call');

    return NextResponse.json({
      policies: policiesWithFreeze,
      meta: {
        total: policiesWithFreeze.length,
        ownCount: ownPolicies.length,
        teamCount: teamPolicies.length,
        limit: freezeStatus.limit,
        frozenCount: freezeStatus.frozenCount,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('API list policies error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
