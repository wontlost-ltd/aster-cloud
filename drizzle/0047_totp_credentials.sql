-- TOTP（验证器 App）绑定与恢复码 —— issue #400 第二步。
--
-- ★secret 用 pgcrypto 可逆加密（验证时需还原出原文现场算码），
--   沿用 BYOK 已有的 pgp_sym_encrypt / AI_KEY_ENCRYPTION_SECRET，不另起一套。
-- ★恢复码只存 sha256，与邮件验证码同一纪律。

CREATE TABLE IF NOT EXISTS "TotpCredential" (
  "id" text PRIMARY KEY NOT NULL,
  "userId" text NOT NULL,
  "encryptedSecret" text NOT NULL,
  "confirmedAt" timestamp,
  "lastUsedCounter" integer,
  "createdAt" timestamp DEFAULT now() NOT NULL
);

-- 一个用户至多一个 TOTP 绑定：并发调用"重新生成"时，
-- 靠这个约束保证不会插出两行（后到者走 upsert）。
CREATE UNIQUE INDEX IF NOT EXISTS "TotpCredential_userId_key" ON "TotpCredential" ("userId");
CREATE INDEX IF NOT EXISTS "TotpCredential_userId_idx" ON "TotpCredential" ("userId");

CREATE TABLE IF NOT EXISTS "TotpRecoveryCode" (
  "id" text PRIMARY KEY NOT NULL,
  "userId" text NOT NULL,
  "codeHash" text NOT NULL,
  "usedAt" timestamp,
  "createdAt" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "TotpRecoveryCode_userId_idx" ON "TotpRecoveryCode" ("userId");
CREATE INDEX IF NOT EXISTS "TotpRecoveryCode_codeHash_idx" ON "TotpRecoveryCode" ("codeHash");
