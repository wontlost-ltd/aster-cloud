-- 只读核查（#712）：团队策略被放在私有分组（分组无 teamId）或别的团队分组里的行。
-- 放置规则见 src/lib/policy-access.ts canPlaceInGroup：团队策略只能放进同一团队的分组。
-- teamId 为空串的历史行按个人策略处理（与 policyTeamIdOf 一致），不算违规。
SELECT p.id            AS "policyId",
       p."teamId"      AS "teamId",
       p."userId"      AS "policyUserId",
       p."groupId"     AS "groupId",
       g."teamId"      AS "groupTeamId",
       g."userId"      AS "groupUserId",
       p."deletedAt"   AS "deletedAt"
FROM "Policy" p
JOIN "PolicyGroup" g ON g.id = p."groupId"
WHERE NULLIF(p."teamId", '') IS NOT NULL
  AND g."teamId" IS DISTINCT FROM p."teamId"
ORDER BY p."teamId", p.id;
