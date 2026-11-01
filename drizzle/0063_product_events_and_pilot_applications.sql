-- 需求验证（产品方向 2026-11 §5.1）：第一方产品分析事件 + 落地页试点申请。纯新增，不改既有表。
--   ProductEvent：事件名 + 假名化 actor / tenant（HMAC，不是原始 id）+ 白名单属性；dedupeKey 唯一索引
--     保证「首次保存 / 首次执行」这类事件每个用户只记一次（NULL 互不冲突，普通事件不受影响）。
--   PilotApplication：试点申请表单；不存 IP，referrer 只存主机名，emailDomain 单列便于区分企业域名与个人邮箱。
-- 两张表新建即空，非并发建索引安全。
CREATE TYPE "public"."PilotUseCase" AS ENUM('insurance_rating', 'credit_decisions', 'agent_guardrails', 'eligibility_rules', 'other');--> statement-breakpoint
CREATE TABLE "PilotApplication" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"emailDomain" text NOT NULL,
	"freeMailDomain" boolean NOT NULL,
	"company" text NOT NULL,
	"role" text NOT NULL,
	"useCases" "PilotUseCase"[] NOT NULL,
	"painPoint" text,
	"consentAt" timestamp (3) NOT NULL,
	"landingPage" text NOT NULL,
	"locale" text NOT NULL,
	"utmSource" text,
	"utmMedium" text,
	"utmCampaign" text,
	"utmTerm" text,
	"utmContent" text,
	"referrerHost" text,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ProductEvent" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"actorId" text,
	"tenantId" text,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupeKey" text,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "PilotApplication_createdAt_idx" ON "PilotApplication" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "PilotApplication_emailDomain_idx" ON "PilotApplication" USING btree ("emailDomain");--> statement-breakpoint
CREATE INDEX "ProductEvent_name_createdAt_idx" ON "ProductEvent" USING btree ("name","createdAt");--> statement-breakpoint
CREATE INDEX "ProductEvent_actorId_idx" ON "ProductEvent" USING btree ("actorId");--> statement-breakpoint
CREATE UNIQUE INDEX "ProductEvent_dedupeKey_key" ON "ProductEvent" USING btree ("dedupeKey");