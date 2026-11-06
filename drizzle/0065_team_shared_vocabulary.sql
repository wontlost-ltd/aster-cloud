-- #672 / ADR 0017：团队共享领域词汇。只放宽约束、按归属拆分活跃唯一索引，不改数据。
-- 部署顺序：先于或后于 Worker 均可。迁移前新 Worker 的团队写入被旧 CHECK 拒绝（个人路径不受影响）；
-- 迁移后旧 Worker 只写个人行（ownerType='user'），新约束与新索引对其透明。整段在迁移事务内执行，
-- 换索引期间不存在无唯一约束的窗口。
ALTER TABLE "UserDomainTerm" DROP CONSTRAINT IF EXISTS "UserDomainTerm_owner_v1_check";--> statement-breakpoint
ALTER TABLE "UserDomainTerm" DROP CONSTRAINT IF EXISTS "UserDomainTerm_owner_check";--> statement-breakpoint
ALTER TABLE "UserDomainTerm" ADD CONSTRAINT "UserDomainTerm_owner_check" CHECK (("UserDomainTerm"."ownerType" = 'user' AND "UserDomainTerm"."teamId" IS NULL) OR ("UserDomainTerm"."ownerType" = 'team' AND "UserDomainTerm"."teamId" IS NOT NULL));--> statement-breakpoint
-- 个人行的活跃唯一索引加上 ownerType='user' 谓词：同一用户可以同时有个人词条与自己创建的同一团队词条。
DROP INDEX IF EXISTS "UserDomainTerm_active_unique";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "UserDomainTerm_active_unique" ON "UserDomainTerm" USING btree ("userId","termId") WHERE "UserDomainTerm"."ownerType" = 'user' AND "UserDomainTerm"."deletedAt" IS NULL AND "UserDomainTerm"."archivedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "UserDomainTerm_team_active_unique" ON "UserDomainTerm" USING btree ("teamId","termId") WHERE "UserDomainTerm"."ownerType" = 'team' AND "UserDomainTerm"."deletedAt" IS NULL AND "UserDomainTerm"."archivedAt" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "UserDomainTerm_team_domain_idx" ON "UserDomainTerm" USING btree ("teamId","domain","locale") WHERE "UserDomainTerm"."ownerType" = 'team' AND "UserDomainTerm"."deletedAt" IS NULL AND "UserDomainTerm"."archivedAt" IS NULL;
