-- #646：schema.ts 与迁移链结果对齐（迁移链重放出的库 = 生产库，以它为准逐项比对）。
--
-- ★为什么需要：多张表最初由 drizzle-kit push 建成，之后的迁移是手写 SQL，而 drizzle/meta 快照
--   一直按 schema.ts 更新——快照里"有"的索引在迁移 SQL 里从未建过。生产库按迁移链清空重建后，
--   PolicyVersion 只剩主键：(policyId, version) 唯一索引缺失，并发创建首个版本可得到两行
--   version=1、prevHash=null。其余缺失项同理。
--
-- 只补 schema.ts 声明而库里缺的部分（索引、唯一约束、列默认值）；库里已有而 schema.ts 写法不同的
-- （jsonb、timestamp(3)、*_key 唯一索引名、部分索引 WHERE、CHECK、外键名、enum 顺序）改 schema.ts
-- 去对齐库，不动生产列类型。防回归：src/__tests__/integration/schema-migration-drift.integration.test.ts。
--
-- 上线前提：新增的唯一索引要求现有数据无重复。生产库刚按迁移链重建，PolicyVersion 为空；
-- User / Team 若已有数据，可先用下列查询确认无重复（有结果则先人工处理再发布）：
--   SELECT "policyId", version, count(*) FROM "PolicyVersion" GROUP BY 1, 2 HAVING count(*) > 1;
--   SELECT email, count(*) FROM "User" WHERE email IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
--   SELECT "stripeCustomerId", count(*) FROM "User" WHERE "stripeCustomerId" IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
--   SELECT "subscriptionId", count(*) FROM "User" WHERE "subscriptionId" IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
--   SELECT slug, count(*) FROM "Team" GROUP BY 1 HAVING count(*) > 1;
--
-- 幂等：全部 IF NOT EXISTS / SET DEFAULT，迁移 Job 重跑是 no-op。

-- ① PolicyVersion：版本号唯一（哈希链不分叉的最后一道防线）+ 查询索引
CREATE UNIQUE INDEX IF NOT EXISTS "PolicyVersion_policyId_version_key" ON "PolicyVersion" USING btree ("policyId","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "PolicyVersion_policyId_idx" ON "PolicyVersion" USING btree ("policyId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "PolicyVersion_sourceHash_idx" ON "PolicyVersion" USING btree ("sourceHash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "PolicyVersion_status_idx" ON "PolicyVersion" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "PolicyVersion_policyId_status_idx" ON "PolicyVersion" USING btree ("policyId","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "PolicyVersion_policyId_isDefault_idx" ON "PolicyVersion" USING btree ("policyId","isDefault");--> statement-breakpoint

-- ② User / Team：唯一约束（以唯一索引实现，与 schema.ts 的 uniqueIndex 一致）与外键查询索引
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_unique" ON "User" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "User_stripeCustomerId_unique" ON "User" USING btree ("stripeCustomerId");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "User_subscriptionId_unique" ON "User" USING btree ("subscriptionId");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "Team_slug_unique" ON "Team" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Team_ownerId_idx" ON "Team" USING btree ("ownerId");--> statement-breakpoint

-- ③ Execution：列表 / 统计查询索引
CREATE INDEX IF NOT EXISTS "Execution_userId_idx" ON "Execution" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Execution_policyId_idx" ON "Execution" USING btree ("policyId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Execution_createdAt_idx" ON "Execution" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Execution_success_idx" ON "Execution" USING btree ("success");--> statement-breakpoint

-- ④ updatedAt 缺默认值：schema.ts 声明 defaultNow()，drizzle 插入时不带该列就依赖库默认值，
--    缺默认值会 NOT NULL 失败。createdAt 等列的 CURRENT_TIMESTAMP 与 now() 等价，统一写法便于逐项比对。
ALTER TABLE "User" ALTER COLUMN "updatedAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "Team" ALTER COLUMN "updatedAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "Policy" ALTER COLUMN "updatedAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "PolicyGroup" ALTER COLUMN "updatedAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "DemoPolicy" ALTER COLUMN "updatedAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "UsageRecord" ALTER COLUMN "updatedAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "ApiKey" ALTER COLUMN "createdAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "AuditLog" ALTER COLUMN "createdAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "ComplianceReport" ALTER COLUMN "createdAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "DemoAuditLog" ALTER COLUMN "createdAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "DemoExecution" ALTER COLUMN "createdAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "DemoPolicy" ALTER COLUMN "createdAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "DemoPolicyVersion" ALTER COLUMN "createdAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "DemoSession" ALTER COLUMN "createdAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "Execution" ALTER COLUMN "createdAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "PasswordResetToken" ALTER COLUMN "createdAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "Policy" ALTER COLUMN "createdAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "PolicyApproval" ALTER COLUMN "createdAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "PolicyGroup" ALTER COLUMN "createdAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "PolicyRecycleBin" ALTER COLUMN "deletedAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "PolicyVersion" ALTER COLUMN "createdAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "SecurityEvent" ALTER COLUMN "createdAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "Team" ALTER COLUMN "createdAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "TeamInvitation" ALTER COLUMN "createdAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "TeamMember" ALTER COLUMN "createdAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "UsageRecord" ALTER COLUMN "createdAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "UsedNonce" ALTER COLUMN "usedAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "User" ALTER COLUMN "createdAt" SET DEFAULT now();
