-- #698：执行记录落库时所属租户（ADR 0016 §3）。团队策略的日志 / 证据按 tenantId 过滤。
ALTER TABLE "Execution" ADD COLUMN IF NOT EXISTS "tenantId" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Execution_policyId_tenantId_idx" ON "Execution" USING btree ("policyId","tenantId");--> statement-breakpoint
-- 回填（幂等：只改 tenantId IS NULL 的行）。能证明「执行时执行人属于策略所在团队」的团队策略执行记为团队：
--   1) 执行人是现任成员且入队时间不晚于执行时间；
--   2) 经该团队的团队 key 执行；
--   3) 执行人是策略创建者、执行晚于策略创建，且两者之间没有该成员被移出该团队的记录。
UPDATE "Execution" e
SET "tenantId" = p."teamId"
FROM "Policy" p
WHERE e."policyId" = p."id"
  AND e."tenantId" IS NULL
  AND NULLIF(p."teamId", '') IS NOT NULL
  AND (
    EXISTS (
      SELECT 1 FROM "TeamMember" tm
      WHERE tm."teamId" = p."teamId" AND tm."userId" = e."userId" AND tm."createdAt" <= e."createdAt"
    )
    OR EXISTS (
      SELECT 1 FROM "ApiKey" k WHERE k."id" = e."apiKeyId" AND k."teamId" = p."teamId"
    )
    OR (
      e."userId" = p."userId"
      AND e."createdAt" >= p."createdAt"
      AND NOT EXISTS (
        SELECT 1 FROM "SecurityEvent" se
        WHERE se."details"->>'action' = 'TEAM_MEMBER_REMOVED'
          AND se."details"->>'teamId' = p."teamId"
          AND se."details"->>'removedUserId' = e."userId"
          AND se."createdAt" BETWEEN p."createdAt" AND e."createdAt"
      )
    )
  );--> statement-breakpoint
-- 其余行（个人策略的执行、团队外经公开 / 分享的执行、无法证明执行时属于团队的历史行）记为执行人自己的租户：
-- 经团队 key 执行取 key 的团队，否则取执行人 userId。
UPDATE "Execution" e
SET "tenantId" = COALESCE(
  (SELECT NULLIF(k."teamId", '') FROM "ApiKey" k WHERE k."id" = e."apiKeyId"),
  e."userId"
)
WHERE e."tenantId" IS NULL;
