-- ADR 0051 §9 存量重编译的逐行状态（cloud "PolicyVersion"，与 aster-api policy_versions 各自独立）。纯附加：
--   resolverVersion：按新解析规则编译成功或新建的行写入 1，NULL=待迁移（失败行保持 NULL，重跑会再试）；
--   resolverMigrationError：最近一次迁移失败的原因，成功时清空；
--   archivedByResolverMigration：仅迁移任务自己归档的行为 true，人工/业务归档保持 false；
--   statusBeforeArchive：迁移任务归档前的状态，修复后重跑成功时据此恢复。
ALTER TABLE "PolicyVersion" ADD COLUMN IF NOT EXISTS "resolverVersion" integer;--> statement-breakpoint
ALTER TABLE "PolicyVersion" ADD COLUMN IF NOT EXISTS "resolverMigrationError" text;--> statement-breakpoint
ALTER TABLE "PolicyVersion" ADD COLUMN IF NOT EXISTS "archivedByResolverMigration" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "PolicyVersion" ADD COLUMN IF NOT EXISTS "statusBeforeArchive" "PolicyVersionStatus";
