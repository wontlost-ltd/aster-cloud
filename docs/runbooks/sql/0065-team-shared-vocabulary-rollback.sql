-- 迁移 0065（#672 / ADR 0017 团队共享词汇）的回滚。
--
-- 前提：先把 Worker 回退到不含团队词汇的版本（否则回滚后团队写入会被旧 CHECK 拒绝）。
-- 旧 CHECK 不允许任何 ownerType='team' 行（含软删），所以先整行导出到备份表再删除；
-- 已冻结的团队快照（UserVocabularySnapshot.ownerType='team'）不受旧约束影响，保留，已审批版本照常执行。
-- 重新前滚：再跑 0065 后执行文件末尾注释里的恢复语句。
-- 用法：psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/runbooks/sql/0065-team-shared-vocabulary-rollback.sql
BEGIN;

CREATE TABLE IF NOT EXISTS "UserDomainTerm_team_backup_0065" AS
  SELECT * FROM "UserDomainTerm" WHERE false;
INSERT INTO "UserDomainTerm_team_backup_0065"
  SELECT * FROM "UserDomainTerm" udt
  WHERE udt."ownerType" = 'team'
    AND NOT EXISTS (SELECT 1 FROM "UserDomainTerm_team_backup_0065" b WHERE b."id" = udt."id");
DELETE FROM "UserDomainTerm" WHERE "ownerType" = 'team';

DROP INDEX IF EXISTS "UserDomainTerm_team_domain_idx";
DROP INDEX IF EXISTS "UserDomainTerm_team_active_unique";
DROP INDEX IF EXISTS "UserDomainTerm_active_unique";
CREATE UNIQUE INDEX "UserDomainTerm_active_unique" ON "UserDomainTerm" USING btree ("userId","termId")
  WHERE "UserDomainTerm"."deletedAt" IS NULL AND "UserDomainTerm"."archivedAt" IS NULL;

ALTER TABLE "UserDomainTerm" DROP CONSTRAINT IF EXISTS "UserDomainTerm_owner_check";
ALTER TABLE "UserDomainTerm" ADD CONSTRAINT "UserDomainTerm_owner_v1_check"
  CHECK ("UserDomainTerm"."ownerType" = 'user' AND "UserDomainTerm"."userId" IS NOT NULL AND "UserDomainTerm"."teamId" IS NULL);

-- 让 drizzle 迁移器认为 0065 未执行，便于之后重新前滚（created_at = drizzle/meta/_journal.json 中 0065 的 when）。
DELETE FROM drizzle."__drizzle_migrations" WHERE created_at = 1793929814952;

COMMIT;

-- 重新前滚 0065 后恢复团队词条：
--   INSERT INTO "UserDomainTerm" SELECT * FROM "UserDomainTerm_team_backup_0065" ON CONFLICT DO NOTHING;
--   DROP TABLE "UserDomainTerm_team_backup_0065";
