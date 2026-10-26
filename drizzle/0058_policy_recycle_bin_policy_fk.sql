-- #603：PolicyRecycleBin.policyId 补外键（ON DELETE CASCADE）。
-- 此前无外键，永久删除 / 过期清理只删 Policy，回收站留下孤儿行，GET /api/policies/trash 持续 500。
--
-- ① 先清掉存量孤儿行（指向已不存在的 Policy），否则建外键会因违反约束而失败。
--    孤儿行对应的策略本体已物理删除，快照无法恢复，删除不丢有效数据。
DELETE FROM "PolicyRecycleBin" b
WHERE NOT EXISTS (SELECT 1 FROM "Policy" p WHERE p."id" = b."policyId");
--> statement-breakpoint
-- ② 建外键。用 duplicate_object 守卫保证迁移 Job 重跑幂等。
DO $$ BEGIN
  ALTER TABLE "PolicyRecycleBin"
    ADD CONSTRAINT "PolicyRecycleBin_policyId_Policy_id_fk"
    FOREIGN KEY ("policyId") REFERENCES "public"."Policy"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
