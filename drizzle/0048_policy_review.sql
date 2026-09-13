-- 策略复核：复核人授权 + 复核结论（ADR 0037 §15）。
--
-- ★两张表分工：
--   PolicyReviewer — 谁有资格复核**这一条**策略（按策略授予，非全团队角色）
--   PolicyProof    — 复核结论本身（**append-only**，撤销＝追加覆盖）
--
-- ★用 IF NOT EXISTS：与 0044–0047 同范式。drizzle 的 snapshot 落后于这几个
--   手写迁移（它会把已存在的 2FA 表也重新生成一遍），故本文件**手写**，
--   只含本次真正新增的两张表。

-- 复核人授权（ADR 0037 §15 决议②：按策略授予）
--
-- ★为什么不是给团队成员加一个全局 domain_expert 角色位：
--   复核资格通常针对**具体策略**——懂信贷风控的未必懂 HIPAA。
--   全团队一刀切会让"有资格"这件事失去意义。
CREATE TABLE IF NOT EXISTS "PolicyReviewer" (
	"id" text PRIMARY KEY NOT NULL,
	"policyId" text NOT NULL,
	"userId" text NOT NULL,
	-- 'domain_expert' | 'engineer' —— 与 ADR 0037 的 ProofSubject 一一对应
	"subjectKind" text DEFAULT 'domain_expert' NOT NULL,
	-- 授权人（审计）：通常是策略拥有者
	"grantedByUserId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "PolicyReviewer_policy_user_key"
	ON "PolicyReviewer" USING btree ("policyId","userId");
CREATE INDEX IF NOT EXISTS "PolicyReviewer_policyId_idx"
	ON "PolicyReviewer" USING btree ("policyId");
CREATE INDEX IF NOT EXISTS "PolicyReviewer_userId_idx"
	ON "PolicyReviewer" USING btree ("userId");

-- 复核结论（ADR 0037 的 Proof 落库形态）
--
-- ★★append-only：**不得 UPDATE，不得 DELETE**。
--   ADR 0037 §15 决议③：结论不可撤销，只能追加新 Proof 覆盖。
--   「当前有效结论」由 ProofIr.resolveEffective **算出来**（取最新适用的那条），
--   而不是改出来的——历史因此完整保留，审计可回溯。
--
-- ★刻意**不建** (policyId, nodeId) 唯一索引：同一节点允许多条，
--   那正是"追加覆盖"的实现方式。
CREATE TABLE IF NOT EXISTS "PolicyProof" (
	"id" text PRIMARY KEY NOT NULL,
	"policyId" text NOT NULL,
	-- proof 是对**某一版**策略做出的
	"policyVersionId" text,
	-- ADR 0037 的 nodeId，形如 $.decls{r}.body.statements[0].expr
	"nodeId" text NOT NULL,
	-- 判定时该节点子树的内容指纹（SHA-256 十六进制，64 字符）。
	-- 内容一变，isApplicableTo 算出 CONTENT_CHANGED，而非悄悄沿用旧结论。
	"contentHash" text NOT NULL,
	-- 'VERIFIED' | 'REJECTED'
	"verdict" text NOT NULL,
	-- ★必填且非空：没有理由的批准等于没有复核（写入层已拒空串）
	"reason" text NOT NULL,
	-- 'domain_expert' | 'engineer' —— ★不允许 'verifier'：机器不得代签
	"subjectKind" text NOT NULL,
	"subjectUserId" text NOT NULL,
	-- 规则会演进，旧 proof 须能说清"当时用的哪一版"
	"ruleId" text DEFAULT 'human-review' NOT NULL,
	"ruleVersion" text DEFAULT '1' NOT NULL,
	-- 原文片段与位置（便于 UI 回放当时看到的内容）
	"text" text NOT NULL,
	"spanStart" integer NOT NULL,
	"spanEnd" integer NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);

-- resolveEffective 的主查询：按 (policy, node) 取最新一条
CREATE INDEX IF NOT EXISTS "PolicyProof_policy_node_idx"
	ON "PolicyProof" USING btree ("policyId","nodeId","createdAt");
CREATE INDEX IF NOT EXISTS "PolicyProof_policyId_idx"
	ON "PolicyProof" USING btree ("policyId");
CREATE INDEX IF NOT EXISTS "PolicyProof_subjectUserId_idx"
	ON "PolicyProof" USING btree ("subjectUserId");
