-- 证据链补齐（ADR 0041 §4）：决策五态与可查证据列；旧行不回填（证据包标 legacy）。
-- ★ADD VALUE 必须单独成语句且不能在同一事务内被使用；本文件只加值不用值。
ALTER TYPE "public"."ExecutionDecision" ADD VALUE IF NOT EXISTS 'require_approval';
--> statement-breakpoint
ALTER TYPE "public"."ExecutionDecision" ADD VALUE IF NOT EXISTS 'escalate';
--> statement-breakpoint
ALTER TABLE "Execution" ADD COLUMN IF NOT EXISTS "outcome" text;
--> statement-breakpoint
ALTER TABLE "Execution" ADD COLUMN IF NOT EXISTS "ruleId" text;
--> statement-breakpoint
ALTER TABLE "Execution" ADD COLUMN IF NOT EXISTS "controls" jsonb;
--> statement-breakpoint
ALTER TABLE "Execution" ADD COLUMN IF NOT EXISTS "agent" jsonb;
--> statement-breakpoint
ALTER TABLE "Execution" ADD COLUMN IF NOT EXISTS "evidenceCorrelationId" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Execution_evidenceCorrelationId_idx" ON "Execution" USING btree ("evidenceCorrelationId");
