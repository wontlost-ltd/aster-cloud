-- 「记住该设备」——用户主动勾选后跳过二次验证（issue #400）。
--
-- ★存的是随机 token 的 sha256，**不是设备指纹**：指纹是被动采集的跨站可
-- 追踪标识，用户无从察觉也无从清除，且并不更安全（可伪造）。
-- 随机 token 的三个性质：用户主动授权、清 cookie 即失效、可服务端吊销。
--
-- label 只存粗粒度描述（如 "Chrome on macOS"）供用户辨认，不存完整 UA——
-- 完整 UA 本身就接近指纹。
CREATE TABLE IF NOT EXISTS "TrustedDevice" (
  "id" text PRIMARY KEY NOT NULL,
  "userId" text NOT NULL,
  "tokenHash" text NOT NULL,
  "label" text,
  "expires" timestamp NOT NULL,
  "lastUsedAt" timestamp,
  "createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "TrustedDevice_tokenHash_unique" ON "TrustedDevice" USING btree ("tokenHash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "TrustedDevice_userId_idx" ON "TrustedDevice" USING btree ("userId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "TrustedDevice_expires_idx" ON "TrustedDevice" USING btree ("expires");
