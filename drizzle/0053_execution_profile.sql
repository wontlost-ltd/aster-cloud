-- 执行行记录模块声明的治理档案 id（ADR 0046 §6）。可空、纯附加：旧行与未声明档案的执行保持 NULL，不回填。
ALTER TABLE "Execution" ADD COLUMN IF NOT EXISTS "profile" text;
