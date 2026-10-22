import 'server-only';

import { getUsageStats } from '@/lib/usage';
import { db, policies, executions } from '@/lib/prisma';
import { eq, desc, sql, inArray, and, isNull } from 'drizzle-orm';
import { getPolicyFreezeStatus } from '@/lib/policy-freeze';

/** 仪表盘服务端数据：用量统计 + 「常用策略」（按执行次数取前 5 个未删除策略）。 */
export async function getDashboardData(userId: string) {
  const [stats, policiesData, freezeStatus] = await Promise.all([
    getUsageStats(userId),
    // 「常用策略」只列未删除的策略：已软删的进回收站，不再出现在首页
    db.query.policies.findMany({
      where: and(eq(policies.userId, userId), isNull(policies.deletedAt)),
      orderBy: desc(policies.updatedAt),
      limit: 20, // 只获取最近的20个用于排序
    }),
    getPolicyFreezeStatus(userId),
  ]);

  // Aggregate execution counts in a single GROUP BY query instead of
  // one count(*) per policy. The previous N+1 loop made TTFB scale
  // linearly with the number of policies; over Hyperdrive each round
  // trip is its own network hop.
  const policyIds = policiesData.map((p) => p.id);
  const countRows = policyIds.length
    ? await db
        .select({
          policyId: executions.policyId,
          c: sql<number>`count(*)::int`,
        })
        .from(executions)
        .where(inArray(executions.policyId, policyIds))
        .groupBy(executions.policyId)
    : [];
  const countByPolicy = new Map<string, number>(
    countRows.map((r) => [r.policyId, r.c]),
  );

  const policiesWithCount = policiesData.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    piiFields: p.piiFields as string[] | null,
    updatedAt: p.updatedAt.toISOString(),
    _count: { executions: countByPolicy.get(p.id) ?? 0 },
    isFrozen: freezeStatus.frozenPolicyIds.has(p.id),
  }));

  // 按执行次数排序，取前5个
  const topPolicies = policiesWithCount
    .sort((a, b) => b._count.executions - a._count.executions)
    .slice(0, 5);

  return { stats, policies: topPolicies };
}
