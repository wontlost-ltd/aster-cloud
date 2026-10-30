import 'server-only';

import { getUsageStats } from '@/lib/usage';
import { db, policies, executions } from '@/lib/prisma';
import { desc, sql, inArray, and, isNull } from 'drizzle-orm';
import { getPolicyFreezeStatus } from '@/lib/policy-freeze';
import { ownPoliciesVisibleTo } from '@/lib/policy-access';

/** 仪表盘服务端数据：用量统计 + 「常用策略」（按执行次数取前 5 个未删除策略）。 */
export async function getDashboardData(userId: string) {
  const [stats, policiesData, freezeStatus] = await Promise.all([
    getUsageStats(userId),
    // 「常用策略」只列未删除的策略：已软删的在回收站里，不出现在首页。
    // 本人创建的团队策略只在本人仍可查看时列出（离队后不暴露名称 / 描述 / 计数，ADR 0016）
    db.query.policies.findMany({
      where: and(ownPoliciesVisibleTo(userId), isNull(policies.deletedAt)),
      orderBy: desc(policies.updatedAt),
      limit: 20, // 只获取最近的20个用于排序
    }),
    getPolicyFreezeStatus(userId),
  ]);

  // 用一条 GROUP BY 汇总各策略的执行次数，而不是每个策略各查一次 count(*)：
  // 经 Hyperdrive 每次往返都是一次网络开销，逐个查询会让首字节时间随策略数线性增长。
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
