-- ADR 0048：BYOK 绑定可选模型。
--   model           : 用户指定的模型 id；NULL=平台该 provider 默认。
--   availableModels : 最近一次 provider /v1/models 结果 { models, defaultModel }，仅校验/提示用。
--   modelsCheckedAt : 上次查询时间。
-- 全部 nullable，不破坏现有行；IF NOT EXISTS 与 db-bootstrap 自愈路径幂等一致。
ALTER TABLE "AiKeyBinding" ADD COLUMN IF NOT EXISTS "model" text;--> statement-breakpoint
ALTER TABLE "AiKeyBinding" ADD COLUMN IF NOT EXISTS "availableModels" jsonb;--> statement-breakpoint
ALTER TABLE "AiKeyBinding" ADD COLUMN IF NOT EXISTS "modelsCheckedAt" timestamp;
