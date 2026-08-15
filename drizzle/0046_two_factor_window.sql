-- 二次验证的**跨码限次窗口**（issue #400，安全审查 Critical 1）。
--
-- 原实现只有 attempts（每码 5 次），而达上限时**删行** → hasActiveCode 失效
-- → 下次提交空码即签发新码、计数归零 → 无限重开。实测约 20 万轮即有
-- 63% 命中 6 位码，限次形同虚设。
--
-- 修法：把限次的锚点从「码」搬到「邮箱 + 时间窗」，这三个字段随重新签发
-- **继承**而非重置。
ALTER TABLE "TwoFactorCode" ADD COLUMN IF NOT EXISTS "windowAttempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "TwoFactorCode" ADD COLUMN IF NOT EXISTS "windowStartedAt" timestamp;
--> statement-breakpoint
ALTER TABLE "TwoFactorCode" ADD COLUMN IF NOT EXISTS "windowIssued" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- ★email 唯一：应用层 delete-then-insert 无事务，并发下会留下两条有效码
--   （审查实测 concurrent_valid_codes=2）。先清理可能已存在的重复行。
DELETE FROM "TwoFactorCode" a USING "TwoFactorCode" b
  WHERE a."email" = b."email" AND a."createdAt" < b."createdAt";
--> statement-breakpoint
DROP INDEX IF EXISTS "TwoFactorCode_email_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "TwoFactorCode_email_unique" ON "TwoFactorCode" USING btree ("email");
