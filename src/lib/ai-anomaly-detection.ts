// AI 异常检测：扫描 aiUsageRecords 找盗刷迹象，触发自动封禁
// 详见 aster-deploy/docs/pm/07-ai-billing.md L3
//
// 由 cron 每 5 分钟调用一次 detectAndBan()。

import { db, users, aiUsageRecords } from '@/lib/prisma';
import { and, eq, gte, sql, isNotNull } from 'drizzle-orm';
import { BILLABLE_STATUS_SQL } from '@/lib/ai-quota';

interface AnomalySignal {
  userId: string;
  reason: string;
  banUntil: Date;
}

/**
 * 扫描最近 1 小时的 aiUsageRecords，找出异常用户并自动封禁。
 * 返回被封禁的用户清单（供 Slack 告警用）。
 */
export async function detectAndBan(): Promise<AnomalySignal[]> {
  const since = new Date(Date.now() - 60 * 60 * 1000); // 1h
  const signals: AnomalySignal[] = [];

  // 信号 1：同一 prompt 重复 ≥ 5 次（自动化脚本特征）
  const repeats = await db
    .select({
      userId: aiUsageRecords.userId,
      promptHash: aiUsageRecords.promptHash,
      c: sql<number>`count(*)::int`,
    })
    .from(aiUsageRecords)
    .where(and(gte(aiUsageRecords.createdAt, since), isNotNull(aiUsageRecords.promptHash)))
    .groupBy(aiUsageRecords.userId, aiUsageRecords.promptHash)
    .having(sql`count(*) >= 5`);

  for (const r of repeats) {
    signals.push({
      userId: r.userId,
      reason: `同一 prompt 重复 ${r.c} 次（疑似脚本化滥用）`,
      banUntil: new Date(Date.now() + 24 * 60 * 60 * 1000), // 封 24h
    });
  }

  // 信号 2：1h 内 token 总量异常（> 100k tokens）
  const heavyUsers = await db
    .select({
      userId: aiUsageRecords.userId,
      total: sql<number>`coalesce(sum("promptTokens" + "completionTokens"), 0)::int`,
    })
    .from(aiUsageRecords)
    .where(and(gte(aiUsageRecords.createdAt, since), eq(aiUsageRecords.usedByok, false)))
    .groupBy(aiUsageRecords.userId)
    .having(sql`coalesce(sum("promptTokens" + "completionTokens"), 0) > 100000`);

  for (const u of heavyUsers) {
    signals.push({
      userId: u.userId,
      reason: `1 小时内消耗 ${u.total.toLocaleString()} tokens，远超合理用量`,
      banUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
  }

  // 信号 3：失败率超高（≥10 次调用 + > 80% 失败 = 401/403/429）
  // 「失败」只算被拒类状态（配额/限流/封禁/安全拦截）。到达 provider 后失败的 api_error 属于计费调用，
  // 多由 provider 故障或 BYOK 模型配置错误造成，不是探测信号，不计入失败率。
  const sinceIso = since.toISOString();
  const failingUsers = await db.execute(sql`
    SELECT
      "userId",
      COUNT(*)::int AS total,
      SUM(CASE WHEN status NOT IN (${BILLABLE_STATUS_SQL}) THEN 1 ELSE 0 END)::int AS failed
    FROM "AiUsageRecord"
    WHERE "createdAt" >= ${sinceIso}::timestamp
    GROUP BY "userId"
    HAVING COUNT(*) >= 10
       AND SUM(CASE WHEN status NOT IN (${BILLABLE_STATUS_SQL}) THEN 1 ELSE 0 END) * 1.0 / COUNT(*) > 0.8
  `);

  for (const row of failingUsers as unknown as Array<{ userId: string; total: number; failed: number }>) {
    signals.push({
      userId: row.userId,
      reason: `失败率 ${Math.round((row.failed / row.total) * 100)}% (${row.failed}/${row.total})，疑似探测行为`,
      banUntil: new Date(Date.now() + 60 * 60 * 1000), // 失败率高仅封 1h，避免误伤
    });
  }

  // 信号 4：jailbreak / prompt-injection 累计 ≥ 3 次（24h 内自动 24h 封禁）
  // 安全策略命中由 ai-content-safety.ts 在调用前同步阻断时写入 safetyFlags
  const jailbreakSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const jailbreakUsers = await db.execute(sql`
    SELECT "userId", COUNT(*)::int AS strikes
    FROM "AiUsageRecord"
    WHERE "createdAt" >= ${jailbreakSince}::timestamp
      AND "safetyFlags" IS NOT NULL
      AND ("safetyFlags"->>'jailbreak_attempt')::boolean = true
    GROUP BY "userId"
    HAVING COUNT(*) >= 3
  `);

  for (const row of jailbreakUsers as unknown as Array<{ userId: string; strikes: number }>) {
    signals.push({
      userId: row.userId,
      reason: `内容安全策略命中 ${row.strikes} 次（疑似 prompt injection / jailbreak）`,
      banUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
  }

  // 信号 5：注册 IP 聚类（同 signupIpHash 24h 内 ≥ 5 个新账号有 LLM 调用 → 全部冻结）
  // 隔离薅羊毛流水线：批量注册然后挨个用配额的攻击模式
  const clusterSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const clusters = await db.execute(sql`
    SELECT u."signupIpHash" AS hash, array_agg(DISTINCT u.id) AS user_ids
    FROM "User" u
    WHERE u."signupIpHash" IS NOT NULL
      AND u."createdAt" >= ${clusterSince}::timestamp
      AND EXISTS (
        SELECT 1 FROM "AiUsageRecord" r
        WHERE r."userId" = u.id
          AND r."createdAt" >= ${clusterSince}::timestamp
      )
    GROUP BY u."signupIpHash"
    HAVING COUNT(DISTINCT u.id) >= 5
  `);

  // 冻结直到管理员人工审核（aiBannedUntil = 100 年后视为永久）
  const reviewBan = new Date(Date.now() + 365 * 100 * 24 * 60 * 60 * 1000);
  for (const row of clusters as unknown as Array<{ hash: string; user_ids: string[] }>) {
    for (const uid of row.user_ids) {
      signals.push({
        userId: uid,
        reason: `可疑批量注册（同 IP ${row.user_ids.length} 个账号活跃，待人工审核）`,
        banUntil: reviewBan,
      });
    }
  }

  // 应用封禁
  const seen = new Set<string>();
  for (const s of signals) {
    if (seen.has(s.userId)) continue;
    seen.add(s.userId);
    await db
      .update(users)
      .set({
        aiBannedUntil: s.banUntil,
        aiBanReason: s.reason,
      })
      .where(eq(users.id, s.userId));

    // 行为信号回写到 risk-tier：被自动封禁本身就是一个强信号，tier +1
    // （受 raiseRiskTier 内部 clamp 到 4 保护，幂等）
    try {
      const { raiseRiskTier } = await import('@/lib/risk-tier');
      await raiseRiskTier(db, s.userId, 'ai_anomaly_ban');
    } catch {
      // fail-open：raise 失败不应阻塞 ban 路径
    }

    // SNAP-4: 推送 ban 状态到 aster-api（让本地 redis 立即拒绝）
    try {
      const { pushUserSnapshot } = await import('@/lib/snapshot-pusher');
      await pushUserSnapshot(s.userId);
    } catch {
      // fail-open；aster-api 1h TTL + warm-up 兜底
    }
  }

  return signals;
}
