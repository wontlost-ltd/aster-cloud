-- 团队作用域 API key 与 owner 共享配额池（ADR 0015 §1）。
-- ★IF NOT EXISTS：与 0044–0048 同范式，生产可能已手工加列。
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "teamId" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ApiKey_teamId_idx" ON "ApiKey" USING btree ("teamId");
--> statement-breakpoint
ALTER TABLE "ApiCallRecord" ADD COLUMN IF NOT EXISTS "quotaOwnerId" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ApiCall_quotaOwnerId_period_idx" ON "ApiCallRecord" USING btree ("quotaOwnerId", "periodMonth", "status");
