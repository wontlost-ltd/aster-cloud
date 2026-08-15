-- 登录二次验证的一次性邮件验证码（issue #400）。
--
-- codeHash 存的是 sha256(6 位码)，不存明文：只读的 DB 泄露不应直接产出
-- 可用的登录凭据（与 PasswordResetToken 同一纪律）。
--
-- attempts 是安全参数而非体验参数：6 位码只有 100 万种可能，
-- 不限次则可在有效期内枚举。
CREATE TABLE IF NOT EXISTS "TwoFactorCode" (
  "id" text PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "codeHash" text NOT NULL,
  "expires" timestamp NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "TwoFactorCode_email_idx" ON "TwoFactorCode" USING btree ("email");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "TwoFactorCode_expires_idx" ON "TwoFactorCode" USING btree ("expires");
