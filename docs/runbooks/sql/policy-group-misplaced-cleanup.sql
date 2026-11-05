-- 清理（#712，可选，幂等）：把核查 SQL 列出的团队策略移到「未分组」（groupId = NULL）。
-- 只改 groupId，不动策略内容与版本；先跑 policy-group-misplaced-check.sql 确认清单再执行。
UPDATE "Policy" p
SET "groupId" = NULL
FROM "PolicyGroup" g
WHERE g.id = p."groupId"
  AND NULLIF(p."teamId", '') IS NOT NULL
  AND g."teamId" IS DISTINCT FROM p."teamId";
