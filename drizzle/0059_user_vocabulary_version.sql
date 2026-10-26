-- #608：用户词汇版本号。编辑器轮询它判断词汇是否变化（取代进程内 EventEmitter 的 SSE，
-- 后者在 Cloudflare Workers 多 isolate 下收不到）。
--
-- ★依赖顺序：本迁移编号 0059，排在 PR #617 的 0058_policy_recycle_bin_policy_fk 之后。
--   两者互不依赖，但 _journal.json 需按编号合入（when 已大于 0058）。
CREATE TABLE IF NOT EXISTS "UserVocabularyVersion" (
	"userId" text PRIMARY KEY NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "UserVocabularyVersion" ADD CONSTRAINT "UserVocabularyVersion_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
-- 版本由 UserDomainTerm 上的**语句级**触发器在写入所在事务内递增：任何写路径（单条增改删恢复、
-- 同步/异步批量、快照回滚、留存归档、DSAR 清理）都会改变版本，应用代码不必逐处维护。
-- 语句级 + 过渡表：一条批量 INSERT 写 250 行也只给每个受影响用户递增一次，
-- 不会在同一事务里对同一版本行做 250 次更新。过渡表要求每种事件单独一个触发器。
--
-- DELETE 时只给仍存在的用户递增：删除 User 级联删词条时，用户行在本语句里已删除，
-- 此时再 upsert 版本行会违反外键；版本行本身随 User 级联删除。
CREATE OR REPLACE FUNCTION "bump_user_vocabulary_version_inserted"() RETURNS trigger AS $$
BEGIN
  INSERT INTO "UserVocabularyVersion" ("userId", "version", "updatedAt")
  SELECT DISTINCT n."userId", 1, now() FROM new_rows n
  ON CONFLICT ("userId") DO UPDATE
    SET "version" = "UserVocabularyVersion"."version" + 1, "updatedAt" = now();
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- UPDATE 同时取新旧两侧的 userId：把链接改到另一个用户名下（目前没有这种写法）时双方都递增。
CREATE OR REPLACE FUNCTION "bump_user_vocabulary_version_updated"() RETURNS trigger AS $$
BEGIN
  INSERT INTO "UserVocabularyVersion" ("userId", "version", "updatedAt")
  SELECT u."userId", 1, now()
    FROM (SELECT "userId" FROM new_rows UNION SELECT "userId" FROM old_rows) u
  ON CONFLICT ("userId") DO UPDATE
    SET "version" = "UserVocabularyVersion"."version" + 1, "updatedAt" = now();
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "bump_user_vocabulary_version_deleted"() RETURNS trigger AS $$
BEGIN
  INSERT INTO "UserVocabularyVersion" ("userId", "version", "updatedAt")
  SELECT DISTINCT o."userId", 1, now()
    FROM old_rows o
   WHERE EXISTS (SELECT 1 FROM "User" u WHERE u."id" = o."userId")
  ON CONFLICT ("userId") DO UPDATE
    SET "version" = "UserVocabularyVersion"."version" + 1, "updatedAt" = now();
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "UserDomainTerm_bump_version_ins" ON "UserDomainTerm";
--> statement-breakpoint
CREATE TRIGGER "UserDomainTerm_bump_version_ins"
  AFTER INSERT ON "UserDomainTerm"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "bump_user_vocabulary_version_inserted"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "UserDomainTerm_bump_version_upd" ON "UserDomainTerm";
--> statement-breakpoint
CREATE TRIGGER "UserDomainTerm_bump_version_upd"
  AFTER UPDATE ON "UserDomainTerm"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "bump_user_vocabulary_version_updated"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "UserDomainTerm_bump_version_del" ON "UserDomainTerm";
--> statement-breakpoint
CREATE TRIGGER "UserDomainTerm_bump_version_del"
  AFTER DELETE ON "UserDomainTerm"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "bump_user_vocabulary_version_deleted"();
