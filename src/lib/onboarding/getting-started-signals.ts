/**
 * @module lib/onboarding/getting-started-signals
 *
 * 「上手清单」的完成信号（#796）：按当前用户从真实数据派生，不新增列或表。
 *
 * <p>全部信号放进一条 SELECT 的若干 EXISTS 子查询，一次往返；每个子查询都以 userId 打头，
 * 走已有索引（Execution_userId_idx、TeamMember_userId_idx、ApiKey / AiKeyBinding 的 userId 索引），
 * EXISTS 命中第一行即停，不随历史数据增长。
 *
 * <p>「有同事」只认未过期的邀请：过期未接受的邀请不代表团队里有人。
 *
 * <p>「提交过审批」读的是 submitForApproval 写的 APPROVAL_DECISION / SUBMIT_FOR_APPROVAL 安全事件
 * （见 services/policy/version-manager.ts），与审批收件箱的提交人口径一致。
 */
import 'server-only';

import { sql } from 'drizzle-orm';
import { db } from '@/lib/prisma';
import type { GettingStartedSignals } from './getting-started';

interface SignalRow {
  hasPreferences: boolean;
  hasRun: boolean;
  hasTeammate: boolean;
  hasSubmittedApproval: boolean;
  hasGuardDecision: boolean;
  hasApiKey: boolean;
  hasAiKey: boolean;
}

/** drizzle 不同驱动下 execute 返回数组或 { rows }，两种都接受。 */
function firstRow<T>(result: unknown): T | undefined {
  if (Array.isArray(result)) return result[0] as T | undefined;
  return (result as { rows?: T[] }).rows?.[0];
}

export async function loadGettingStartedSignals(params: {
  userId: string;
  /** 已由仪表盘统计得出，不重复查询。 */
  hasPolicy: boolean;
  plan: string | null | undefined;
}): Promise<GettingStartedSignals> {
  const { userId } = params;
  const result = await db.execute(sql`
    SELECT
      EXISTS (SELECT 1 FROM "User" u WHERE u."id" = ${userId} AND u."onboardingCompletedAt" IS NOT NULL) AS "hasPreferences",
      EXISTS (SELECT 1 FROM "Execution" e WHERE e."userId" = ${userId}) AS "hasRun",
      EXISTS (
        SELECT 1 FROM "TeamMember" me
        WHERE me."userId" = ${userId}
          AND (
            EXISTS (SELECT 1 FROM "TeamMember" other WHERE other."teamId" = me."teamId" AND other."userId" <> me."userId")
            OR EXISTS (SELECT 1 FROM "TeamInvitation" inv WHERE inv."teamId" = me."teamId" AND inv."expiresAt" > now())
          )
      ) AS "hasTeammate",
      EXISTS (
        SELECT 1 FROM "SecurityEvent" se
        WHERE se."userId" = ${userId}
          AND se."eventType" = 'APPROVAL_DECISION'
          AND se."details"->>'action' = 'SUBMIT_FOR_APPROVAL'
      ) AS "hasSubmittedApproval",
      EXISTS (
        SELECT 1 FROM "Execution" g
        WHERE g."userId" = ${userId} AND g."metadata"->>'guardDecisionId' IS NOT NULL
      ) AS "hasGuardDecision",
      EXISTS (SELECT 1 FROM "ApiKey" k WHERE k."userId" = ${userId}) AS "hasApiKey",
      EXISTS (SELECT 1 FROM "AiKeyBinding" b WHERE b."userId" = ${userId} AND b."active" = true) AS "hasAiKey"
  `);
  const row = firstRow<SignalRow>(result);
  return {
    hasPreferences: row?.hasPreferences === true,
    hasPolicy: params.hasPolicy,
    hasRun: row?.hasRun === true,
    hasTeammate: row?.hasTeammate === true,
    hasSubmittedApproval: row?.hasSubmittedApproval === true,
    hasGuardDecision: row?.hasGuardDecision === true,
    hasApiKey: row?.hasApiKey === true,
    hasAiKey: row?.hasAiKey === true,
    hasReviewedBilling: params.plan !== 'trial' && params.plan !== 'free',
  };
}
