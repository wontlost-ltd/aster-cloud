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
-- 版本由 UserDomainTerm 上的行级触发器在写入所在事务内递增：任何写路径（单条增改删恢复、
-- 同步/异步批量、快照回滚、留存归档、DSAR 清理）都会改变版本，应用代码不必逐处维护。
--
-- DELETE 时先确认用户仍存在：删除 User 级联删词条时，用户行在本语句里已删除，
-- 此时再 upsert 版本行会违反外键；用户都没了，版本也无意义，直接跳过
-- （版本行本身随 User 级联删除）。
CREATE OR REPLACE FUNCTION "bump_user_vocabulary_version"() RETURNS trigger AS $$
DECLARE
  uid text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    uid := OLD."userId";
    IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = uid) THEN
      RETURN NULL;
    END IF;
  ELSE
    uid := NEW."userId";
  END IF;
  INSERT INTO "UserVocabularyVersion" ("userId", "version", "updatedAt")
  VALUES (uid, 1, now())
  ON CONFLICT ("userId") DO UPDATE
    SET "version" = "UserVocabularyVersion"."version" + 1,
        "updatedAt" = now();
  -- UPDATE 把链接改到另一个用户名下（目前没有这种写法）时，旧用户也要递增。
  IF TG_OP = 'UPDATE' AND OLD."userId" IS DISTINCT FROM NEW."userId" THEN
    UPDATE "UserVocabularyVersion"
       SET "version" = "version" + 1, "updatedAt" = now()
     WHERE "userId" = OLD."userId";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "UserDomainTerm_bump_vocabulary_version" ON "UserDomainTerm";
--> statement-breakpoint
CREATE TRIGGER "UserDomainTerm_bump_vocabulary_version"
  AFTER INSERT OR UPDATE OR DELETE ON "UserDomainTerm"
  FOR EACH ROW EXECUTE FUNCTION "bump_user_vocabulary_version"();
