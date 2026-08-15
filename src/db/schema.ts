/**
 * Drizzle ORM Schema
 * 从 Prisma schema 迁移而来，用于 Cloudflare Workers/Pages 环境
 */
import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  bigint,
  json,
  jsonb,
  numeric,
  pgEnum,
  uniqueIndex,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { desc, relations, sql } from 'drizzle-orm';

// ============================================
// Enums
// ============================================

export const planEnum = pgEnum('Plan', ['free', 'trial', 'pro', 'team', 'enterprise']);

export const subscriptionStatusEnum = pgEnum('SubscriptionStatus', [
  'active',
  'past_due',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'trialing',
  'unpaid',
  'paused',
]);

export const policyVersionStatusEnum = pgEnum('PolicyVersionStatus', [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'DEPRECATED',
  'ARCHIVED',
]);

export const approvalDecisionEnum = pgEnum('ApprovalDecision', [
  'APPROVED',
  'REJECTED',
  'REQUESTED_CHANGES',
]);

export const securityEventTypeEnum = pgEnum('SecurityEventType', [
  'SIGNATURE_INVALID',
  'NONCE_REUSED',
  'TIMESTAMP_EXPIRED',
  'HASH_MISMATCH',
  'UNAUTHORIZED_APPROVAL',
  'SELF_APPROVAL_ATTEMPT',
  'POLICY_EXECUTED',
  'APPROVAL_DECISION',
  'VERSION_CREATED',
  'VERSION_NOT_FOUND',
  'DEPRECATED_VERSION_EXECUTED',
  'VERSION_SET_DEFAULT',
  'VERSION_DEPRECATED',
  'VERSION_ARCHIVED',
]);

export const eventSeverityEnum = pgEnum('EventSeverity', [
  'INFO',
  'WARNING',
  'ERROR',
  'CRITICAL',
]);

export const executionSourceEnum = pgEnum('ExecutionSource', [
  'dashboard',
  'api',
  'playground',
]);

// 执行决策结果（ADR 0022 后续）。与 boolean success（=allowed，准入通过）正交、更细：
// approved(放行)/denied(真实拒绝)/indeterminate(执行成功但无 allow/deny 语义，如 greet
// 返回文本值)/error(执行报错)。审计/统计据此正确分类，避免把值输出策略误计入失败。
// **由服务端从执行结果派生，绝不信客户端输入**。
export const executionDecisionEnum = pgEnum('ExecutionDecision', [
  'approved',
  'denied',
  'indeterminate',
  'error',
]);

export const usageTypeEnum = pgEnum('UsageType', [
  'execution',
  'pii_scan',
  'compliance_report',
  'api_call',
]);

export const teamRoleEnum = pgEnum('TeamRole', ['owner', 'admin', 'member', 'viewer']);

export const complianceTypeEnum = pgEnum('ComplianceType', [
  'gdpr',
  'hipaa',
  'soc2',
  'pci_dss',
  'custom',
]);

export const reportStatusEnum = pgEnum('ReportStatus', [
  'generating',
  'completed',
  'failed',
]);

// ============================================
// NextAuth.js 必需的模型
// ============================================

export const accounts = pgTable(
  'Account',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('userId').notNull(),
    type: text('type').notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('providerAccountId').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
    refresh_token_expires_in: integer('refresh_token_expires_in'),
  },
  (table) => [
    uniqueIndex('Account_provider_providerAccountId_key').on(
      table.provider,
      table.providerAccountId
    ),
    index('Account_userId_idx').on(table.userId),
  ]
);

export const sessions = pgTable(
  'Session',
  {
    id: text('id').primaryKey().notNull(),
    sessionToken: text('sessionToken').notNull().unique(),
    userId: text('userId').notNull(),
    expires: timestamp('expires', { mode: 'date' }).notNull(),
  },
  (table) => [index('Session_userId_idx').on(table.userId)]
);

export const verificationTokens = pgTable(
  'VerificationToken',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull().unique(),
    expires: timestamp('expires', { mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('VerificationToken_identifier_token_key').on(
      table.identifier,
      table.token
    ),
  ]
);

/**
 * 登录二次验证的一次性邮件验证码（issue #400）。
 *
 * <h3>为什么不复用 VerificationToken / PasswordResetToken</h3>
 *
 * - `VerificationToken` 没有尝试次数字段。6 位码只有 100 万种可能，
 *   **必须限次**，否则在有效期内可被暴力枚举。
 * - `PasswordResetToken` 语义是"重置密码"，混用会让两条链路的失效逻辑纠缠
 *   （改密码要不要连带作废 2FA 码？）。分表让各自的生命周期独立。
 *
 * <h3>存的是 sha256(code)，不是明文</h3>
 *
 * 与 `password-reset-tokens.ts` 同一纪律：只读的 DB 泄露不应直接产出可用的
 * 登录凭据。校验时对传入的码做同样的 hash 再比对。
 */
export const twoFactorCodes = pgTable(
  'TwoFactorCode',
  {
    id: text('id').primaryKey().notNull(),
    /** 归属邮箱（小写规范化后），与登录时用的口径一致 */
    email: text('email').notNull(),
    /** sha256(6 位码) 的小写 hex —— ★不存明文 */
    codeHash: text('codeHash').notNull(),
    expires: timestamp('expires', { mode: 'date' }).notNull(),
    /**
     * 已尝试次数。达到上限即作废，防止 6 位码被暴力枚举。
     *
     * ★与账户锁定（`account-lockout.ts`）是**两条独立的轴**：
     * 那条锁的是"密码错太多次"，这条锁的是"验证码错太多次"。
     * 合并会让攻击者用错误验证码把受害者的账户锁死（拒绝服务）。
     */
    attempts: integer('attempts').default(0).notNull(),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('TwoFactorCode_email_idx').on(table.email),
    index('TwoFactorCode_expires_idx').on(table.expires),
  ]
);

export const passwordResetTokens = pgTable(
  'PasswordResetToken',
  {
    id: text('id').primaryKey().notNull(),
    email: text('email').notNull(),
    token: text('token').notNull().unique(),
    expires: timestamp('expires', { mode: 'date' }).notNull(),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('PasswordResetToken_email_idx').on(table.email),
    index('PasswordResetToken_token_idx').on(table.token),
  ]
);

// ============================================
// User 模型
// ============================================

export const users = pgTable(
  'User',
  {
    id: text('id').primaryKey().notNull(),
    name: text('name'),
    email: text('email').unique(),
    /**
     * 反多重注册去重键（gmail+xxx 剥离、点号去除、toLowerCase）
     * 详见 lib/email-normalize.ts
     */
    emailNormalized: text('emailNormalized'),
    emailVerified: timestamp('emailVerified', { mode: 'date' }),
    image: text('image'),
    passwordHash: text('passwordHash'),

    // Account Lockout
    failedLoginAttempts: integer('failedLoginAttempts').default(0).notNull(),
    lastFailedLoginAt: timestamp('lastFailedLoginAt', { mode: 'date' }),
    lockedUntil: timestamp('lockedUntil', { mode: 'date' }),
    lockoutCount: integer('lockoutCount').default(0).notNull(),

    // Subscription
    plan: planEnum('plan').default('free').notNull(),
    stripeCustomerId: text('stripeCustomerId').unique(),
    subscriptionId: text('subscriptionId').unique(),
    subscriptionStatus: subscriptionStatusEnum('subscriptionStatus'),
    // 老用户保护：首次锁定价格的时间，决定走 LEGACY_PLAN_LIMITS 还是 PM_PLAN_LIMITS_V2
    priceLockedAt: timestamp('priceLockedAt', { mode: 'date' }),
    // 遗留档位标记：grandfather Team 客户用（plan='pro' + legacyTier='team' = 老 Team 客户，UI 显示 Pro）
    legacyTier: text('legacyTier'),

    // Trial
    trialStartedAt: timestamp('trialStartedAt', { mode: 'date' }),
    trialEndsAt: timestamp('trialEndsAt', { mode: 'date' }),
    // F2.5 trial 邮件发送幂等标记：避免 webhook 重投导致重复发邮件
    trialEndingEmailSentAt: timestamp('trialEndingEmailSentAt', { mode: 'date' }),

    // AI 防盗刷自动封禁（v1.0 详见 07-ai-billing.md L3 异常检测）
    aiBannedUntil: timestamp('aiBannedUntil', { mode: 'date' }),
    aiBanReason: text('aiBanReason'),
    /**
     * 注册时的 SHA256(ip+salt) 前 16 字符（GDPR 数据最小化）
     * 用于反多重注册聚类检测：同 hash 24h 内 ≥5 个新账号有 LLM 调用 → 全部冻结
     */
    signupIpHash: text('signupIpHash'),

    // API 配额警告邮件幂等标记（避免 cron 重复发送，按 periodMonth 重置）
    apiQuotaWarn80SentAt: timestamp('apiQuotaWarn80SentAt', { mode: 'date' }),
    apiQuotaWarn100SentAt: timestamp('apiQuotaWarn100SentAt', { mode: 'date' }),
    apiQuotaWarn200SentAt: timestamp('apiQuotaWarn200SentAt', { mode: 'date' }),

    // Dunning 催收（详见 aster-deploy/docs/pm/08-dunning.md）
    /** 首次支付失败的时间戳；用于判断 grace period 起点 */
    gracePeriodStartsAt: timestamp('gracePeriodStartsAt', { mode: 'date' }),
    /** Grace period 截止日（now + 21d）；超过此日期 + 仍未付款 → auto-downgrade */
    gracePeriodEndsAt: timestamp('gracePeriodEndsAt', { mode: 'date' }),
    /** 已发送的催收邮件次数（0..4），用于幂等控制 */
    dunningEmailsSentCount: integer('dunningEmailsSentCount').default(0).notNull(),
    /** 上次催收邮件发送时间（避免一天发多封） */
    lastDunningEmailSentAt: timestamp('lastDunningEmailSentAt', { mode: 'date' }),
    /** 自动降级到 Free 的时间；30 天内重新付款可恢复，之后由 GDPR cleanup 清理 */
    downgradedAt: timestamp('downgradedAt', { mode: 'date' }),

    // Onboarding
    onboardingUseCase: text('onboardingUseCase'),
    onboardingGoals: text('onboardingGoals').array(),
    onboardingCompletedAt: timestamp('onboardingCompletedAt', { mode: 'date' }),

    // Soft-delete + grace-period reactivation
    /** 用户发起自删的时间。非空 → 账号处于墓碑状态，正常 signIn 拒绝。 */
    deletedAt: timestamp('deletedAt', { mode: 'date' }),
    /** Hard-purge 时间点（deletedAt + 30d）。cron 到此时间真正物理删除。 */
    purgePendingUntil: timestamp('purgePendingUntil', { mode: 'date' }),
    /** grace 期内复活的次数（审计 / 反复活滥用）。 */
    reactivationCount: integer('reactivationCount').default(0).notNull(),
    /** 该 emailNormalized 历史上被清理的次数（hard-purge 时累计，下次同邮箱注册时携带）。 */
    priorPurgeCount: integer('priorPurgeCount').default(0).notNull(),
    /**
     * 注册风险分层（0=trusted .. 4=hard block）。在 createUser 中计算并 freeze。
     * 由 lib/risk-tier.ts 评估；下游模块（trial、AI quota、API quota、Stripe）
     * 据此分流。详见 docs/risk-tier-design.md。
     */
    riskTier: integer('riskTier').default(0).notNull(),
    /** riskTier 评分时的关键原因（用于审计 + 客户支持 + 申诉）。 */
    riskTierReason: text('riskTierReason'),

    /**
     * 平台级 admin。**与套餐 plan 解耦**：plan=enterprise 的客户不会
     * 自动变 admin，反过来 admin 也可以是 free 用户。
     *
     * 用于 /admin/* 页面 + API 路由的 server-side gate（lib/admin-auth.ts）。
     * 默认 false；唯一授予方式：DBA / 紧急情况下 SQL 手动 set true。
     *
     * 避免之前 plan='enterprise' 当 admin 的设计：第一个真实 enterprise
     * 客户付费时其 owner 会自动看见全平台用户列表（数据泄露）。
     */
    isAdmin: boolean('isAdmin').default(false).notNull(),

    /**
     * 回放留存准入开关（ADR 0030 pii-admission/v1）。tenant（=userId）级 opt-in：
     * true 时该租户执行的 RegressionCase 可长期留存明文 inputJson（供 semantic replay）；
     * false（默认）时只冻结 canonical hash，不存明文金融输入（case 标 replay-limited，
     * 无法 semantic run）。默认关=不留明文，须显式授权。回归工具（rule-regression）据此
     * 决定是否把 Execution 明文冻进 golden case。
     */
    replayRetentionEnabled: boolean('replayRetentionEnabled').default(false).notNull(),

    /**
     * Force password change on next login.
     *
     * Set to `true` when an account is provisioned with a temporary
     * password (e.g. admin bootstrap via `pnpm seed:admin`, or future
     * admin-issued invitations). Cleared the moment the user
     * successfully runs the change-password flow.
     *
     * The login + middleware path checks this flag after auth and
     * redirects to /onboarding/change-password before letting the user
     * reach any other dashboard surface.
     */
    mustChangePassword: boolean('mustChangePassword').default(false).notNull(),

    /**
     * BYOK 月度用量重置水位线（用户「重置额度」按钮）。
     *
     * 「已用额度」是 byokTokensUsedThisMonth 对不可变 aiUsageRecords 的**每用户聚合 SUM**
     * （该表无 provider/binding 列 → 无法 per-key 精确）。用户点「重置额度」时不删审计记录
     * （加密 prompt / 计费 / 180 天留存），而是把本水位线盖成 now()——此后 byokTokensUsedThisMonth
     * 只统计 createdAt >= max(当月初, byokQuotaResetAt) 的行，等价于「清空本月已用计数」而不毁账。
     * null=从未重置（按自然月初起算）。语义与现有每用户聚合一致（多 key 版另立）。
     */
    byokQuotaResetAt: timestamp('byokQuotaResetAt', { mode: 'date' }),

    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('User_email_idx').on(table.email),
    index('User_stripeCustomerId_idx').on(table.stripeCustomerId),
    uniqueIndex('User_emailNormalized_unique').on(table.emailNormalized),
    // 用于 cron 找到所有该 hard-purge 的墓碑用户
    index('User_purgePendingUntil_idx').on(table.purgePendingUntil),
  ]
);

export const structuralAliasGrants = pgTable(
  'StructuralAliasGrant',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    grantedBy: text('grantedBy')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    grantedAt: timestamp('grantedAt', { mode: 'date' }).defaultNow().notNull(),
    revokedAt: timestamp('revokedAt', { mode: 'date' }),
  },
  (table) => [
    index('StructuralAliasGrant_userId_idx').on(table.userId),
    // W3：同一用户最多一条「活跃」授权。partial UNIQUE 从 DB 层杜绝 admin POST
    // 的 check-then-insert TOCTOU 竞态产生重复活跃行（重复 → revoke 只撤一条留悬挂授权）。
    // 撤销后 revokedAt 非 NULL 即退出唯一约束，可再次授予。
    uniqueIndex('StructuralAliasGrant_active_unique')
      .on(table.userId)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

// ============================================
// API Keys
// ============================================

export const apiKeys = pgTable(
  'ApiKey',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('userId').notNull(),
    name: text('name').notNull(),
    key: text('key').notNull().unique(),
    prefix: text('prefix').notNull(),
    lastUsedAt: timestamp('lastUsedAt', { mode: 'date' }),
    expiresAt: timestamp('expiresAt', { mode: 'date' }),
    revokedAt: timestamp('revokedAt', { mode: 'date' }),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('ApiKey_userId_idx').on(table.userId),
    index('ApiKey_prefix_idx').on(table.prefix),
  ]
);

// ============================================
// Policy Group
// ============================================

export const policyGroups = pgTable(
  'PolicyGroup',
  {
    id: text('id').primaryKey().notNull(),
    name: text('name').notNull(),
    description: text('description'),
    icon: text('icon'),
    sortOrder: integer('sortOrder').default(0).notNull(),
    parentId: text('parentId'),
    userId: text('userId'),
    teamId: text('teamId'),
    isSystem: boolean('isSystem').default(false).notNull(),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('PolicyGroup_parentId_idx').on(table.parentId),
    index('PolicyGroup_userId_idx').on(table.userId),
    index('PolicyGroup_teamId_idx').on(table.teamId),
    index('PolicyGroup_sortOrder_idx').on(table.sortOrder),
  ]
);

// ============================================
// Policy
// ============================================

export const policies = pgTable(
  'Policy',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('userId').notNull(),
    teamId: text('teamId'),
    groupId: text('groupId'),
    name: text('name').notNull(),
    description: text('description'),
    content: text('content').notNull(),
    version: integer('version').default(1).notNull(),
    isPublic: boolean('isPublic').default(false).notNull(),
    shareSlug: text('shareSlug').unique(),
    piiFields: json('piiFields'),
    deletedAt: timestamp('deletedAt', { mode: 'date' }),
    deletedBy: text('deletedBy'),
    deleteReason: text('deleteReason'),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('Policy_userId_idx').on(table.userId),
    index('Policy_teamId_idx').on(table.teamId),
    index('Policy_groupId_idx').on(table.groupId),
    index('Policy_shareSlug_idx').on(table.shareSlug),
    index('Policy_deletedAt_idx').on(table.deletedAt),
  ]
);

// ============================================
// Policy Version
// ============================================

export const policyVersions = pgTable(
  'PolicyVersion',
  {
    id: text('id').primaryKey().notNull(),
    policyId: text('policyId').notNull(),
    version: integer('version').notNull(),
    content: text('content').notNull(),
    source: text('source'),
    sourceHash: text('sourceHash'),
    prevHash: text('prevHash'),
    comment: text('comment'),
    status: policyVersionStatusEnum('status').default('DRAFT').notNull(),
    createdBy: text('createdBy'),
    isDefault: boolean('isDefault').default(false).notNull(),
    releaseNote: text('releaseNote'),
    deprecatedAt: timestamp('deprecatedAt', { mode: 'date' }),
    deprecatedBy: text('deprecatedBy'),
    archivedAt: timestamp('archivedAt', { mode: 'date' }),
    archivedBy: text('archivedBy'),
    vocabularySnapshotIds: jsonb('vocabularySnapshotIds')
      .$type<Array<{ snapshotId: string; domain: string; locale: string }>>()
      .default([])
      .notNull(),
    // ADR 0022 方案 D：用户自定义关键词别名的版本固化（camelCase 对齐本库 PolicyVersion 命名约定）。
    // aliasSet：该版本编译时冻结的规范别名 JSON（kind→[别名,...]），NULL=无别名。不可变。
    aliasSet: text('aliasSet'),
    // sourceEnvelopeSha256：覆盖完整编译输入（content+aliasSet+locale+工具链）的哈希，防别名替换篡改。
    sourceEnvelopeSha256: text('sourceEnvelopeSha256'),
    // sourceToolchainId：envelope 计算所用工具链身份，供 tip-anchor verifier 重算验证。
    sourceToolchainId: text('sourceToolchainId'),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('PolicyVersion_policyId_version_key').on(table.policyId, table.version),
    index('PolicyVersion_policyId_idx').on(table.policyId),
    index('PolicyVersion_sourceHash_idx').on(table.sourceHash),
    index('PolicyVersion_status_idx').on(table.status),
    index('PolicyVersion_policyId_status_idx').on(table.policyId, table.status),
    index('PolicyVersion_policyId_isDefault_idx').on(table.policyId, table.isDefault),
  ]
);

// ============================================
// Policy Approval
// ============================================

export const policyApprovals = pgTable(
  'PolicyApproval',
  {
    id: text('id').primaryKey().notNull(),
    versionId: text('versionId').notNull(),
    approverId: text('approverId').notNull(),
    decision: approvalDecisionEnum('decision').notNull(),
    comment: text('comment'),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('PolicyApproval_versionId_idx').on(table.versionId),
    index('PolicyApproval_approverId_idx').on(table.approverId),
    index('PolicyApproval_createdAt_idx').on(table.createdAt),
  ]
);

// ============================================
// Used Nonce (防重放攻击)
// ============================================

export const usedNonces = pgTable(
  'UsedNonce',
  {
    id: text('id').primaryKey().notNull(),
    nonce: text('nonce').notNull().unique(),
    policyId: text('policyId'),
    userId: text('userId'),
    usedAt: timestamp('usedAt', { mode: 'date' }).defaultNow().notNull(),
    expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),
  },
  (table) => [
    index('UsedNonce_expiresAt_idx').on(table.expiresAt),
    index('UsedNonce_policyId_idx').on(table.policyId),
  ]
);

// ============================================
// Signup Attempts（注册限流：IP/24h ≤ 3）
// ============================================

/**
 * 注册尝试记录：用 SHA256(ip+salt) 而非明文 IP（GDPR 数据最小化）
 * cron 每天清理 createdAt < now()-24h 的记录
 */
export const signupAttempts = pgTable(
  'SignupAttempt',
  {
    id: text('id').primaryKey().notNull(),
    /** SHA256(ip + SIGNUP_IP_SALT) hex 前 16 字符 */
    ipHash: text('ipHash').notNull(),
    /** 是否最终成功（用于区分尝试 vs. 实际注册） */
    succeeded: boolean('succeeded').default(false).notNull(),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('SignupAttempt_ipHash_createdAt_idx').on(table.ipHash, table.createdAt),
    index('SignupAttempt_createdAt_idx').on(table.createdAt),
  ]
);

// ============================================
// API Call Records（Policy Execution API 配额计数）
// ============================================

/**
 * Policy 执行 API 的调用记录
 *
 * 与 aiUsageRecords（LLM 调用）不同——这里记的是用户编译后的 policy 被
 * 当作 endpoint 调用的次数，按月度配额（plans.ts limits.apiCalls）扣减。
 *
 * 设计：
 *   - userId / tenantId 双索引：tenant=team 时按 team owner 聚合
 *   - 不存请求/响应 body（policy 输入输出可能含 PII；不在此层做内容审计）
 *   - status: success / quota_exhausted / rate_limited / api_error
 *   - 保留 90 天滚动删除（cron 清理）
 */
export const apiCallRecords = pgTable(
  'ApiCallRecord',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('userId').notNull(),
    tenantId: text('tenantId'),
    apiKeyId: text('apiKeyId'),
    /** 'YYYY-MM' 用于按月聚合查询 */
    periodMonth: text('periodMonth').notNull(),
    /** /api/policies/evaluate / evaluate-json / evaluate-source / evaluate/batch */
    endpointPath: text('endpointPath').notNull(),
    /** 调用结果：success / quota_exhausted / rate_limited / api_error */
    status: text('status').notNull(),
    /** 端到端耗时，毫秒 */
    latencyMs: integer('latencyMs').notNull().default(0),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('ApiCall_userId_period_idx').on(table.userId, table.periodMonth),
    index('ApiCall_tenantId_createdAt_idx').on(table.tenantId, table.createdAt),
    index('ApiCall_apiKeyId_createdAt_idx').on(table.apiKeyId, table.createdAt),
    index('ApiCall_createdAt_retention_idx').on(table.createdAt),
  ]
);

// ============================================
// Security Event
// ============================================

export const securityEvents = pgTable(
  'SecurityEvent',
  {
    id: text('id').primaryKey().notNull(),
    eventType: securityEventTypeEnum('eventType').notNull(),
    severity: eventSeverityEnum('severity').notNull(),
    policyId: text('policyId'),
    userId: text('userId'),
    ipAddress: text('ipAddress'),
    userAgent: text('userAgent'),
    requestId: text('requestId'),
    details: json('details').notNull(),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('SecurityEvent_eventType_idx').on(table.eventType),
    index('SecurityEvent_severity_idx').on(table.severity),
    index('SecurityEvent_policyId_idx').on(table.policyId),
    index('SecurityEvent_createdAt_idx').on(table.createdAt),
  ]
);

// ============================================
// Policy Recycle Bin
// ============================================

export const policyRecycleBins = pgTable(
  'PolicyRecycleBin',
  {
    id: text('id').primaryKey().notNull(),
    policyId: text('policyId').notNull().unique(),
    userId: text('userId').notNull(),
    snapshot: json('snapshot').notNull(),
    deletedAt: timestamp('deletedAt', { mode: 'date' }).defaultNow().notNull(),
    deletedBy: text('deletedBy').notNull(),
    expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),
  },
  (table) => [
    index('PolicyRecycleBin_userId_idx').on(table.userId),
    index('PolicyRecycleBin_expiresAt_idx').on(table.expiresAt),
  ]
);

// ============================================
// Execution
// ============================================

export const executions = pgTable(
  'Execution',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('userId').notNull(),
    policyId: text('policyId').notNull(),
    input: json('input').notNull(),
    output: json('output'),
    error: text('error'),
    durationMs: integer('durationMs').notNull(),
    // success：沿用旧语义 = 准入通过（allowed）。真实拒绝/无决策/错误均 success=false。
    // 保持不变以兼容历史行、响应体、日志 UI、统计口径。
    success: boolean('success').notNull(),
    // decision：准入四态语义（approved/denied/indeterminate/error，见 executionDecisionEnum），
    // 与 success 正交、更细。indeterminate（值/计算输出，如 greet 返回文本）靠它与真实 deny 区分，
    // 避免审计/统计把值输出误当失败。可空以兼容历史行（迁移前无此列）。服务端从执行结果派生。
    decision: executionDecisionEnum('decision'),
    policyVersion: integer('policyVersion'),
    source: executionSourceEnum('source').default('dashboard').notNull(),
    apiKeyId: text('apiKeyId'),
    metadata: json('metadata'),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),

    // ═══ P0-A 决策级持久层（ADR 0030 附录 A.1）——回放地基 ═══
    // 全 nullable（兼容历史行）；应用层 invariant：replayCaptureVersion 非空**时**须全 payload 列 set（单向蕴含，
    // M2 完整加密 capture）。★replayabilityStatus 与 replayCaptureVersion 是**两条独立轴**（M2.1b 后）：
    // 行有可信「从冻结 input 重求值」回放路径（P0-A M1 用，不读 replayPayload）即可 REPLAYABLE，不要求 payload
    // 在场。缺 freeze 所需字段（traceHash/canonical*/toolchain 等）→ NON_REPLAYABLE，回归工具跳过（见 buildReplayColumns）。
    // 不可变版本行引用（旧 policyVersion int 保留仅显示）。
    policyVersionRowId: text('policyVersionRowId'),
    functionName: text('functionName'),
    // 执行时实际 locale（非运行时猜测）。
    locale: text('locale'),
    // 冻结的 alias set（无别名写 {}，非 NULL）。
    aliasSetJson: json('aliasSetJson'),
    // 从 PolicyVersion.vocabularySnapshotIds 复制（引用不可变）。
    vocabSnapshotRef: json('vocabSnapshotRef'),
    // 源码/envelope 编译工具链 + 实际执行引擎工具链。
    sourceToolchainId: text('sourceToolchainId'),
    runtimeToolchainId: text('runtimeToolchainId'),
    // machine-readable 决策原因码（非自然语言）。
    reasonCodes: json('reasonCodes'),
    // PII-redacted 结构 trace（原值只在加密 payload）+ trace 的 canonical hash。
    traceJson: json('traceJson'),
    /**
     * 决策骨架（Phase 0）：aster-api TraceSkeleton 的落库形态。
     *
     * <p>★与 traceJson 是**两条不同的 PII 轴**，故独立成列而非复用：
     * traceJson 是含 result 业务值的完整 trace（M2 才落，需 PII envelope）；
     * 骨架**结构上不含任何值**（只有 expression/matched/depth），故可常态采集，
     * 不受 replayRetentionEnabled（默认关）门控。混用一列会让 PII 边界含糊。
     *
     * <p>用途：条件漏斗 / 死分支聚合——回答"这条策略实际怎么走的""哪个条件从未命中"。
     */
    traceSkeletonJson: jsonb('traceSkeletonJson'),
    traceHash: text('traceHash'),
    // canonical input/output hash（见 canonical-json.ts；剔除非决定性字段）。
    canonicalInputHash: text('canonicalInputHash'),
    canonicalOutputHash: text('canonicalOutputHash'),
    canonicalizationVersion: text('canonicalizationVersion'),
    // 回放捕获版本（如 p0a.v1）+ 可回放状态 + 原因。
    replayCaptureVersion: text('replayCaptureVersion'),
    replayabilityStatus: text('replayabilityStatus'),
    replayabilityReasons: json('replayabilityReasons'),
    // PII envelope 加密的完整 replay 真值（原始 input/output/full trace）——KMS 接线前留空（M2）。
    replayPayloadCiphertext: text('replayPayloadCiphertext'),
    replayPayloadAlg: text('replayPayloadAlg'),
    replayPayloadKeyId: text('replayPayloadKeyId'),
    replayPayloadNonce: text('replayPayloadNonce'),
    replayPayloadHash: text('replayPayloadHash'),
    // 到期 crypto-erasure（销毁 DEK），不改行。
    piiRetentionUntil: timestamp('piiRetentionUntil', { mode: 'date' }),
    // 本行适用的数据准入策略版本（如 pii-admission/v1）。
    piiPolicyVersion: text('piiPolicyVersion'),
    // ── runner-parity 影子校验结果（cloud 权威侧 vs runner 侧执行的 5 canonical-hash 字段比对）──
    // ★纯附加、log-only、绝不 gate 决策。NULL=本行未跑 parity（历史行 / mode=off / 未采样）。
    //   status: match | divergent | runner-unavailable | runner-error | authority-failure。
    runnerParityStatus: text('runnerParityStatus'),
    // divergent 时哪些字段不一致（string[] JSON，如 ["canonicalOutputHash","traceHash"]）。
    runnerParityDivergentFields: json('runnerParityDivergentFields'),
    // parity 校验完成时刻（异步 waitUntil 回写；NULL=未跑）。
    runnerParityCheckedAt: timestamp('runnerParityCheckedAt', { mode: 'date' }),
  },
  (table) => [
    index('Execution_userId_idx').on(table.userId),
    index('Execution_policyId_idx').on(table.policyId),
    index('Execution_createdAt_idx').on(table.createdAt),
    index('Execution_success_idx').on(table.success),
    index('Execution_decision_idx').on(table.decision),
    // P0-A 回归工具查询用。
    index('Execution_policyVersionRowId_idx').on(table.policyVersionRowId),
    index('Execution_replayabilityStatus_idx').on(table.replayabilityStatus),
    index('Execution_canonicalInputHash_idx').on(table.canonicalInputHash),
    index('Execution_canonicalOutputHash_idx').on(table.canonicalOutputHash),
    index('Execution_traceHash_idx').on(table.traceHash),
    index('Execution_piiRetentionUntil_idx').on(table.piiRetentionUntil),
    // runner-parity 状态查询（查 divergent/error 快；大量 NULL 未跑行不占索引=部分索引）。
    index('Execution_runnerParityStatus_idx')
      .on(table.runnerParityStatus)
      .where(sql`${table.runnerParityStatus} IS NOT NULL`),
  ]
);

// ============================================
// P0-A 规则集升级回归工具（ADR 0030 M1，附录 B）
// ============================================

/**
 * 业务结果回传（Phase 3）。
 *
 * <p>平台记录「批准/拒绝」，但**不知道该决策事后是否成交/坏账**——
 * 没有这份数据，"改策略会少赚多少钱"这类问题永远答不了
 * （见 docs/strategy-replay-gap-analysis.md 第二节）。本表让客户在决策落地后
 * 回传真实结果，从而把决策与业务后果对齐。
 *
 * <p><b>★一次执行只允许一条有效结果</b>（unique on executionId）：
 * 同一笔决策不该有两个互相矛盾的结局。需要更正时用 upsert 覆盖，
 * 并靠 reportedAt + 审计日志留痕，而不是堆叠多行让下游自己猜哪条算数。
 *
 * <p><b>outcome 取值刻意不做成 enum</b>：不同行业的结局词汇差异极大
 * （信贷 defaulted/repaid、电商 converted/refunded、广告 clicked/ignored）。
 * 硬编码枚举会逼着每加一个垂直行业就改一次 schema。改用自由字符串 + 长度上限，
 * 由租户自己定义词汇；聚合时按字符串分组即可。
 */
export const executionOutcomes = pgTable(
  'ExecutionOutcome',
  {
    id: text('id').primaryKey().notNull(),
    executionId: text('executionId').notNull(),
    /** 归属用户——★与 Execution.userId 冗余存一份，用于租户隔离过滤，
     *  避免聚合查询必须 JOIN Execution 才能确认归属。 */
    userId: text('userId').notNull(),
    policyId: text('policyId').notNull(),
    /** 决策落地后的真实结果，如 'converted' / 'defaulted' / 'refunded'。 */
    outcome: text('outcome').notNull(),
    /** 可选的业务数值（成交额 / 损失额）。用 numeric 而非 float：金额不容浮点误差。 */
    value: numeric('value', { precision: 20, scale: 4 }),
    /** 结果发生的业务时间（非回传时间）——迟报不该扭曲时间序列分析。 */
    occurredAt: timestamp('occurredAt', { mode: 'date' }),
    /** 回传时间（服务端赋值，客户端不可伪造）。 */
    reportedAt: timestamp('reportedAt', { mode: 'date' }).defaultNow().notNull(),
    /** 自由备注（非 PII 承诺——不做脱敏，故文档要求客户不要放个人信息）。 */
    note: text('note'),
  },
  (table) => [
    // 一次执行一条结果
    uniqueIndex('ExecutionOutcome_executionId_key').on(table.executionId),
    index('ExecutionOutcome_userId_idx').on(table.userId),
    index('ExecutionOutcome_policyId_idx').on(table.policyId),
    index('ExecutionOutcome_outcome_idx').on(table.outcome),
    index('ExecutionOutcome_occurredAt_idx').on(table.occurredAt),
  ]
);

/**
 * 不可变回归 golden case。冻结即不可变（服务层无 update/delete）；进报告 hash。
 *
 * <p>来源：Execution 候选冻结（sourceKind='execution'）或作者手写边界 case（'handwritten'）。
 * 缺回放上下文（functionName/locale/canonicalInputHash）的行不会被冻结（候选谓词已过滤）。
 * inputJson 是明文金融输入——**仅当 tenant 开 replayRetentionEnabled 时才存**（ADR
 * pii-admission/v1）；未开则 inputJson 为 null，case 为 replay-limited（无法 semantic run）。
 */
export const regressionCases = pgTable(
  'RegressionCase',
  {
    id: text('id').primaryKey().notNull(),
    policyId: text('policyId').notNull(),
    // 不可变版本行引用（非版本号）。
    policyVersionRowId: text('policyVersionRowId').notNull(),
    policyVersion: integer('policyVersion'),
    functionName: text('functionName').notNull(),
    locale: text('locale').notNull(),
    // 冻结回放上下文（无别名写 {}，无词汇写 []）。
    aliasSetJson: jsonb('aliasSetJson').notNull().default({}),
    vocabSnapshotRef: jsonb('vocabSnapshotRef').notNull().default([]),
    // 明文输入——仅 tenant opt-in 时存；否则 null（case replay-limited）。
    inputJson: jsonb('inputJson'),
    canonicalInputHash: text('canonicalInputHash').notNull(),
    expectedOutputHash: text('expectedOutputHash').notNull(),
    // 冻结时的准入决策（approved/denied/indeterminate/error）——覆盖门禁统计用。
    expectedDecision: text('expectedDecision'),
    canonicalizationVersion: text('canonicalizationVersion').notNull(),
    // execution（从历史冻结）| handwritten（作者补边界）。
    sourceKind: text('sourceKind').notNull(),
    sourceExecutionId: text('sourceExecutionId'),
    // 边界标签：threshold/reject/null/date-boundary/rounding/boundary…（覆盖门禁用）。
    coverageTags: jsonb('coverageTags').notNull().default([]),
    // 冻结时基线工具链（诚实基线：expectedOutputHash 是此工具链下捕获的）。
    baselineRuntimeToolchainId: text('baselineRuntimeToolchainId'),
    sourceToolchainId: text('sourceToolchainId'),
    sourceEnvelopeSha256: text('sourceEnvelopeSha256'),
    // 覆盖核心字段的 canonical hash——防篡改 + 去重锚。
    caseHash: text('caseHash').notNull().unique(),
    // caseHash 公式版本（case-hash/m1.0 | m1.1）——run 重算校验按此选公式（新旧共存）。
    // ★Item 2（迁移 0038）：default 从 m1.0 改 m1.1——m1.0 已被政策定义为**不可签字**弱绑定版本，
    // 新写入不应再默认产生不可签字证据。既有 m1.0 行不动（0036 回填是历史事实）。应用层 freeze 一直显式
    // 写 CASE_HASH_VERSION(m1.1)；改 default 只关闭「直接 DB/遗漏 writer 继续产 m1.0」入口。
    caseHashVersion: text('caseHashVersion').notNull().default('case-hash/m1.1'),
    createdBy: text('createdBy').notNull(),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('RegressionCase_policyId_idx').on(table.policyId),
    index('RegressionCase_policyVersionRowId_idx').on(table.policyVersionRowId),
    index('RegressionCase_canonicalInputHash_idx').on(table.canonicalInputHash),
    // 去重 + 幂等冻结锚（同版本+函数+locale+input 保一条）。
    uniqueIndex('RegressionCase_unique_case_idx').on(
      table.policyVersionRowId,
      table.functionName,
      table.locale,
      table.canonicalInputHash
    ),
    // 证据模型完整性硬化（DB 层防非法枚举值）。
    check('RegressionCase_sourceKind_check', sql`${table.sourceKind} IN ('execution', 'handwritten')`),
    // caseHashVersion 只允许已知公式版本（DB 层 fail-closed，防写入 corrupt 版本绕过完整性校验）。
    check(
      'RegressionCase_caseHashVersion_check',
      sql`${table.caseHashVersion} IN ('case-hash/m1.0', 'case-hash/m1.1')`
    ),
  ]
);

/**
 * 回归报告（审计 artifact，落库非仅返回）。可追溯当时按什么 case/toolchain/hash 判定。
 *
 * <p>M1 comparisonMode 恒 FROZEN_BASELINE_VS_CURRENT_BACKEND：基线是冻结时快照 hash，
 * 非实时重跑 old toolchain（单后端约束，见 ADR 附录 B.1）。
 */
export const regressionReports = pgTable(
  'RegressionReport',
  {
    id: text('id').primaryKey().notNull(),
    policyId: text('policyId').notNull(),
    policyVersionRowId: text('policyVersionRowId').notNull(),
    // PASS | FAIL_REGRESSION | FAIL_INSUFFICIENT_COVERAGE | NON_REPLAYABLE。
    status: text('status').notNull(),
    comparisonMode: text('comparisonMode').notNull(),
    caseCount: integer('caseCount').notNull().default(0),
    runnableCaseCount: integer('runnableCaseCount').notNull().default(0),
    passedCaseCount: integer('passedCaseCount').notNull().default(0),
    failedCaseCount: integer('failedCaseCount').notNull().default(0),
    nonReplayableCaseCount: integer('nonReplayableCaseCount').notNull().default(0),
    coverageJson: jsonb('coverageJson').notNull(),
    reportJson: jsonb('reportJson').notNull(),
    // 覆盖 toolchain + case ids + hash + runner version——报告防篡改。
    reportHash: text('reportHash').notNull().unique(),
    currentRuntimeToolchainId: text('currentRuntimeToolchainId'),
    createdBy: text('createdBy').notNull(),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('RegressionReport_policyVersionRowId_createdAt_idx').on(
      table.policyVersionRowId,
      table.createdAt
    ),
    index('RegressionReport_status_idx').on(table.status),
    check(
      'RegressionReport_status_check',
      // ★报告行 status 只存 4 个**跑出来的**态，永不被改成 PASS（不可变证据）。
      // ACCEPTED_DRIFT_WITH_APPROVAL 是**派生态**——由 RegressionDriftApproval 覆盖 join 计算，不落此列。
      sql`${table.status} IN ('PASS', 'FAIL_REGRESSION', 'FAIL_INSUFFICIENT_COVERAGE', 'NON_REPLAYABLE')`
    ),
  ]
);

/**
 * 受控接受漂移审批（P0-4，ADR 0030 门禁四态 ACCEPTED_DRIFT_WITH_APPROVAL）。
 *
 * <p>★核心不变量（Codex CCO 复审）：**不把 FAIL_REGRESSION 报告改成 PASS**。真实 bugfix 导致的合理漂移
 * 由独立、不可变的审批 artifact 受控接受——原失败报告保持原状，审批只声明「本报告的这些具体 case 漂移
 * 经 {approver} 因 {reason/ticket} 在 {scope/expiry} 内受控接受」。有效状态由 report + 覆盖它全部
 * FAIL_REGRESSION case 的有效审批 join 计算（派生 ACCEPTED_DRIFT_WITH_APPROVAL），不改任何行。
 *
 * <p>职责分离：approvedBy 必须 != 被审批报告的 createdBy——应用层 + 0039 INSERT trigger 在 DB 层执行**声明
 * 身份不相等**检查（★不证明真实主体身份，真身份来自应用认证上下文，见 docs/p0a-db-sod-decision.md）。
 * 每条审批钉死被接受 case 的 before/after output hash——升级后 case 输出再变（漂移超出已批范围）则
 * 审批自动失效（有效性校验时比对当前 report 的 actualOutputHash）。
 */
export const regressionDriftApprovals = pgTable(
  'RegressionDriftApproval',
  {
    id: text('id').primaryKey().notNull(),
    // 被审批的失败报告（不可变引用）+ 其 reportHash（钉死审批针对的确切报告内容）。
    // ★Item 3（迁移 0039）：FK 到 RegressionReport——防直插引用不存在报告的审批（append-only 无 DELETE，
    // 故 ON DELETE NO ACTION）。父表 reportHash/policyId/policyVersionRowId 一致性由 INSERT trigger 校验。
    reportId: text('reportId')
      .notNull()
      .references(() => regressionReports.id, { onDelete: 'no action' }),
    reportHash: text('reportHash').notNull(),
    policyId: text('policyId').notNull(),
    policyVersionRowId: text('policyVersionRowId').notNull(),
    // 被受控接受的 case 漂移明细：[{caseId, baselineOutputHash, acceptedOutputHash}]。
    // 升级后 case 实际输出须等于 acceptedOutputHash 才算「在已批范围内」。
    acceptedDrifts: jsonb('acceptedDrifts').notNull(),
    // 审批理由 + 工单（可审计）。
    reason: text('reason').notNull(),
    ticketRef: text('ticketRef'),
    // 审批人（★声明身份职责分离：声明 approvedBy 必须 != report 声明 createdBy——应用层 + 0039 INSERT
    // trigger 双拦。诚实：这是声明身份不相等，非真身份 SoD；真身份来自应用认证上下文，见 docs/p0a-db-sod-decision.md）。
    approvedBy: text('approvedBy').notNull(),
    approvedAt: timestamp('approvedAt', { mode: 'date' }).defaultNow().notNull(),
    // 有效期（过期后审批失效，须重新审批——防一次审批永久放行未来所有升级）。
    expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),
    // 撤销（append-only 不删，撤销走此列 + 派生态排除已撤销）。
    revokedAt: timestamp('revokedAt', { mode: 'date' }),
    revokedBy: text('revokedBy'),
    // 审批 artifact 防篡改 hash（覆盖 reportHash + acceptedDrifts + approver + reason + expiry）。
    approvalHash: text('approvalHash').notNull().unique(),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('RegressionDriftApproval_reportId_idx').on(table.reportId),
    index('RegressionDriftApproval_policyVersionRowId_idx').on(table.policyVersionRowId),
    // ★一份报告对同一 approver 只允许**一条有效（未撤销）**审批（partial unique；撤销后可再建）。
    // Codex 复审：非唯一 index 会让同 approver 建多条活跃审批，撤销一条另一条仍派生 ACCEPTED。
    uniqueIndex('RegressionDriftApproval_active_unique')
      .on(table.reportId, table.approvedBy)
      .where(sql`${table.revokedAt} IS NULL`),
  ]
);

// ★P0-A S1（信任层5 transition authorization）：已签名的 upgrade-manifest，附到回归报告作为「baseline
// toolchainId X → current Y 是被批准的有方向升级」证据。mirror RegressionDriftApproval（append-only +
// 父一致性 + 声明身份 SoD 触发器，见迁移 0040）。★S1 不解锁签字：manifest 只证「有主体批准了方向」（层5），
// **不**证明执行环境是 X/Y（层3）——报告携此仍 UNSIGNABLE（provenance 未验证）。
export const regressionUpgradeManifests = pgTable(
  'RegressionUpgradeManifest',
  {
    id: text('id').primaryKey().notNull(),
    // 被证明升级的报告（不可变引用）+ 父一致性字段（INSERT trigger 校验与父报告一致）。
    reportId: text('reportId')
      .notNull()
      .references(() => regressionReports.id, { onDelete: 'no action' }),
    reportHash: text('reportHash').notNull(),
    policyId: text('policyId').notNull(),
    policyVersionRowId: text('policyVersionRowId').notNull(),
    // 有方向的 X→Y toolchain 对（升级方向；X≠Y 由签名端 signing-api + 应用层强制）。
    baselineToolchainId: text('baselineToolchainId').notNull(),
    currentToolchainId: text('currentToolchainId').notNull(),
    // 签名工件（signing-api RawSignResult）：canonical payload（被签字节）+ Ed25519 签名 + Vault key 版本 +
    // keyId（独立 regression-transition-signing key，验签按 keyId+purpose 分派信任根）。
    canonicalPayloadB64url: text('canonicalPayloadB64url').notNull(),
    signature: text('signature').notNull(),
    keyId: text('keyId').notNull(),
    keyVersion: text('keyVersion').notNull(),
    // 批准人（★声明身份 SoD：声明 approvedBy != report 声明 createdBy——应用层 + 0040 INSERT trigger 双拦。
    // 诚实：声明身份不相等，非真身份 SoD；真身份来自 2-人 ceremony 的 operator/witness，见 docs/p0a-db-sod-decision.md）。
    approvedBy: text('approvedBy').notNull(),
    approvedAt: timestamp('approvedAt', { mode: 'date' }).defaultNow().notNull(),
    // 有效期（过期后 manifest 失效，须重新批准——防一次批准永久放行）。
    expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),
    // 撤销（append-only 不删；撤销走此列 + 派生态排除已撤销）。
    revokedAt: timestamp('revokedAt', { mode: 'date' }),
    revokedBy: text('revokedBy'),
    // manifest artifact 防篡改 hash（= sha256(canonical payload bytes)；报告 reportJson 挂它作证据）。
    manifestHash: text('manifestHash').notNull().unique(),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('RegressionUpgradeManifest_reportId_idx').on(table.reportId),
    index('RegressionUpgradeManifest_policyVersionRowId_idx').on(table.policyVersionRowId),
    // ★一份报告对同一 (baseline,current) transition 只允许**一条有效（未撤销）** manifest（partial unique）。
    uniqueIndex('RegressionUpgradeManifest_active_unique')
      .on(table.reportId, table.baselineToolchainId, table.currentToolchainId)
      .where(sql`${table.revokedAt} IS NULL`),
  ]
);

// ============================================
// Usage Record
// ============================================

export const usageRecords = pgTable(
  'UsageRecord',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('userId').notNull(),
    type: usageTypeEnum('type').notNull(),
    count: integer('count').default(1).notNull(),
    period: text('period').notNull(),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('UsageRecord_userId_type_period_key').on(
      table.userId,
      table.type,
      table.period
    ),
    index('UsageRecord_userId_period_idx').on(table.userId, table.period),
  ]
);

// ============================================
// Team
// ============================================

export const teams = pgTable(
  'Team',
  {
    id: text('id').primaryKey().notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    ownerId: text('ownerId').notNull(),
    // 团队向其用户开放的 UI 语言白名单（locale 代号数组，如 ['en','hi']）。
    // null = 未配置 = 所有后端可用语言都开放（默认行为，不破坏现有团队）。
    // 由团队 owner/admin 通过语言可用性设置管理。语言切换器的可用集 =
    // 编译支持 ∩ 后端可用 ∩ 此白名单（null 时跳过第三项交集）。
    enabledLocales: jsonb('enabledLocales').$type<string[]>(),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('Team_ownerId_idx').on(table.ownerId),
    index('Team_slug_idx').on(table.slug),
  ]
);

// ============================================
// Team Member
// ============================================

export const teamMembers = pgTable(
  'TeamMember',
  {
    id: text('id').primaryKey().notNull(),
    teamId: text('teamId').notNull(),
    userId: text('userId').notNull(),
    role: teamRoleEnum('role').default('member').notNull(),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('TeamMember_teamId_userId_key').on(table.teamId, table.userId),
    index('TeamMember_userId_idx').on(table.userId),
  ]
);

// ============================================
// Team Invitation
// ============================================

export const teamInvitations = pgTable(
  'TeamInvitation',
  {
    id: text('id').primaryKey().notNull(),
    teamId: text('teamId').notNull(),
    email: text('email').notNull(),
    role: teamRoleEnum('role').default('member').notNull(),
    token: text('token').notNull().unique(),
    expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('TeamInvitation_teamId_idx').on(table.teamId),
    index('TeamInvitation_email_idx').on(table.email),
    index('TeamInvitation_token_idx').on(table.token),
  ]
);

// ============================================
// Platform Setting (admin-controlled feature flags)
// ============================================
//
// Generic key-value store for platform-wide toggles a SaaS admin
// flips at runtime. First inhabitant: `policy_sharing.enabled` —
// gates the policy → team sharing feature. Default OFF.
//
// Why a row-per-flag rather than envs:
//   Workers can change envs only via a redeploy. Admins need an
//   immediate kill-switch they can drive from /admin. Reads are
//   cheap (small table, indexed by key) and the helper layer
//   caches per-isolate.
export const platformSettings = pgTable(
  'PlatformSetting',
  {
    key: text('key').primaryKey().notNull(),
    value: json('value').notNull(),
    updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull(),
    updatedBy: text('updatedBy'),
  },
);

// ============================================
// Policy Share
// ============================================
//
// Many-to-many: one policy can be shared with multiple teams.
// The policy's *owner* (policies.userId, or policies.teamId for
// team-owned policies) is separate from these share rows — owner
// stays unique, shares are read/execute grants to additional teams.
//
// Permissions: a single fixed bundle ('view + execute') for now.
// Edit access deliberately stays with the owner — multi-team edit
// needs a conflict-resolution story we haven't designed yet.
//
// Composite unique on (policyId, teamId) so the same team can't be
// double-added; the UI re-uses this for idempotent share creation.
export const policyShares = pgTable(
  'PolicyShare',
  {
    id: text('id').primaryKey().notNull(),
    policyId: text('policyId').notNull(),
    teamId: text('teamId').notNull(),
    /**
     * Permission bundle granted to the team.
     *   'view'    — read policy + see version history
     *   'execute' — view + run /api/policies/:id/execute
     *
     * 'execute' implies 'view'; the access checks treat them as a
     * ladder, not parallel sets. Default 'execute' so historical
     * rows (pre-tier) stay functional.
     */
    permission: text('permission').notNull().default('execute'),
    /** User who created the share (audit). */
    sharedByUserId: text('sharedByUserId').notNull(),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('PolicyShare_policy_team_key').on(table.policyId, table.teamId),
    index('PolicyShare_teamId_idx').on(table.teamId),
    index('PolicyShare_policyId_idx').on(table.policyId),
  ]
);

export type SharePermission = 'view' | 'execute';
export const SHARE_PERMISSIONS: readonly SharePermission[] = ['view', 'execute'];

/** execute >= view in the permission ladder. */
export function shareCovers(
  granted: SharePermission,
  required: SharePermission,
): boolean {
  if (required === 'view') return granted === 'view' || granted === 'execute';
  return granted === 'execute';
}

// ============================================
// Notification
// ============================================
//
// Generic in-app notification feed. Powers the topbar bell + a future
// drop-down inbox surface. Writers append; readers can mark-read or
// dismiss. The schema is intentionally generic so we can add new
// notification kinds (policy.shared, billing.dunning, etc.) without
// migrations — the kind goes in the `kind` column and the rendering
// payload in `data` JSON.
//
// Current kinds:
//   - team.invitation_received  data: { teamId, teamName, invitationId, role }
//   - team.invitation_accepted  data: { teamId, teamName, memberName }
//
// The pending-invitations card on /teams continues to read live data
// from teamInvitations directly (so an invite that's still pending
// after the user dismisses its notification still shows up); the
// notifications table only drives the bell + transient feed.
export const notifications = pgTable(
  'Notification',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('userId').notNull(),
    kind: text('kind').notNull(),
    data: json('data').notNull(),
    readAt: timestamp('readAt', { mode: 'date' }),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('Notification_userId_idx').on(table.userId),
    index('Notification_userId_readAt_idx').on(table.userId, table.readAt),
    index('Notification_createdAt_idx').on(table.createdAt),
  ]
);

// ============================================
// Compliance Report
// ============================================

export const complianceReports = pgTable(
  'ComplianceReport',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('userId').notNull(),
    type: complianceTypeEnum('type').notNull(),
    title: text('title').notNull(),
    status: reportStatusEnum('status').default('generating').notNull(),
    data: json('data'),
    policyIds: text('policyIds').array(),
    period: text('period'),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
    completedAt: timestamp('completedAt', { mode: 'date' }),
  },
  (table) => [
    index('ComplianceReport_userId_idx').on(table.userId),
    index('ComplianceReport_createdAt_idx').on(table.createdAt),
  ]
);

// ============================================
// Audit Log
// ============================================

export const auditLogs = pgTable(
  'AuditLog',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('userId'),
    teamId: text('teamId'),
    action: text('action').notNull(),
    resource: text('resource').notNull(),
    resourceId: text('resourceId'),
    metadata: json('metadata'),
    ipAddress: text('ipAddress'),
    userAgent: text('userAgent'),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('AuditLog_userId_idx').on(table.userId),
    index('AuditLog_teamId_idx').on(table.teamId),
    index('AuditLog_createdAt_idx').on(table.createdAt),
    index('AuditLog_action_idx').on(table.action),
  ]
);

// ============================================
// Demo 功能数据模型
// ============================================

export const demoSessions = pgTable(
  'DemoSession',
  {
    id: text('id').primaryKey().notNull(),
    sessionId: text('sessionId').notNull().unique(),
    ipAddress: text('ipAddress'),
    userAgent: text('userAgent'),
    expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('DemoSession_expiresAt_idx').on(table.expiresAt),
    index('DemoSession_sessionId_idx').on(table.sessionId),
  ]
);

export const demoPolicies = pgTable(
  'DemoPolicy',
  {
    id: text('id').primaryKey().notNull(),
    sessionId: text('sessionId').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    content: text('content').notNull(),
    version: integer('version').default(1).notNull(),
    defaultInput: json('defaultInput'),
    piiFields: json('piiFields'),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [index('DemoPolicy_sessionId_idx').on(table.sessionId)]
);

export const demoPolicyVersions = pgTable(
  'DemoPolicyVersion',
  {
    id: text('id').primaryKey().notNull(),
    policyId: text('policyId').notNull(),
    version: integer('version').notNull(),
    content: text('content').notNull(),
    comment: text('comment'),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('DemoPolicyVersion_policyId_version_key').on(
      table.policyId,
      table.version
    ),
    index('DemoPolicyVersion_policyId_idx').on(table.policyId),
  ]
);

export const demoExecutions = pgTable(
  'DemoExecution',
  {
    id: text('id').primaryKey().notNull(),
    sessionId: text('sessionId').notNull(),
    policyId: text('policyId').notNull(),
    input: json('input').notNull(),
    output: json('output'),
    error: text('error'),
    durationMs: integer('durationMs').notNull(),
    success: boolean('success').notNull(),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('DemoExecution_sessionId_idx').on(table.sessionId),
    index('DemoExecution_policyId_idx').on(table.policyId),
    index('DemoExecution_createdAt_idx').on(table.createdAt),
  ]
);

export const demoAuditLogs = pgTable(
  'DemoAuditLog',
  {
    id: text('id').primaryKey().notNull(),
    sessionId: text('sessionId').notNull(),
    action: text('action').notNull(),
    resource: text('resource').notNull(),
    resourceId: text('resourceId'),
    metadata: json('metadata'),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('DemoAuditLog_sessionId_idx').on(table.sessionId),
    index('DemoAuditLog_createdAt_idx').on(table.createdAt),
    index('DemoAuditLog_action_idx').on(table.action),
  ]
);

// ============================================
// AI 计费 / 防盗刷（v1.0 详见 aster-deploy/docs/pm/07-ai-billing.md）
// ============================================

/**
 * AI 调用记录（细粒度 token 消耗）
 *
 * 每次成功 / 失败 / 拒绝的 LLM 调用都记一行。
 * 月度配额由 SUM(promptTokens + completionTokens) WHERE periodMonth=YYYY-MM 算出。
 *
 * 设计意图：
 *   - 只记 token 数 + 成本（USD 分）+ 是否走 BYOK，不记 prompt/response 内容（隐私）
 *   - 有租户 / 月份 索引，让 quota 检查 < 50ms
 *   - 异常检测扫描"最近 1h 重复 prompt hash"等用 promptHash 字段
 */
export const aiUsageRecords = pgTable(
  'AiUsageRecord',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('userId').notNull(),
    teamId: text('teamId'),
    /** 'YYYY-MM' 用于按月聚合查询 */
    periodMonth: text('periodMonth').notNull(),
    /** completion / explain / suggest / repair */
    callKind: text('callKind').notNull(),
    model: text('model').notNull(),
    promptTokens: integer('promptTokens').notNull().default(0),
    completionTokens: integer('completionTokens').notNull().default(0),
    /** 估算成本（美分），用 INT 避免浮点精度问题 */
    costCents: integer('costCents').notNull().default(0),
    /** 是否使用了用户绑定的 BYOK key（true 则不计入平台配额） */
    usedByok: boolean('usedByok').notNull().default(false),
    /** 调用结果：success / quota_exhausted / rate_limited / banned / api_error */
    status: text('status').notNull(),
    /** 用于异常检测：prompt 内容的 SHA-256 前缀（不含原文） */
    promptHash: text('promptHash'),
    /**
     * 加密后的原始 prompt（pgp_sym_encrypt 输出 bytea，用 text 列简化）
     * 主密钥独立于 BYOK：env AI_AUDIT_ENCRYPTION_SECRET（Vault 注入）
     * 保留期 180 天，cron 删除
     */
    encryptedPrompt: text('encryptedPrompt'),
    /** 加密后的 LLM 输出，同上 */
    encryptedCompletion: text('encryptedCompletion'),
    /**
     * PII 脱敏后的 prompt 明文（邮箱/手机/卡号等已替换为 [REDACTED:TYPE]）
     * 永久保留：合规要求 + 内容安全分析 + 异常检测训练样本
     */
    redactedPrompt: text('redactedPrompt'),
    /**
     * 内容安全标记
     * { jailbreak_attempt: bool, pii_detected: bool, toxic: bool, blocked_reason?: string }
     * 永久保留，参与 anomaly detection
     */
    safetyFlags: json('safetyFlags').$type<{
      jailbreak_attempt?: boolean;
      pii_detected?: boolean;
      toxic?: boolean;
      blocked_reason?: string;
    }>(),
    /**
     * 请求关联 id（issue #185）：cloud 转发 LLM 前生成，注入 `_usage` envelope 传给 aster-api，
     * aster-api 成功后带同一 requestId 回填真实 token/cost。cloud recordAiUsage 用它 upsert 同一行
     * （占位 0/0 + 精确回填 = 同一笔），避免双记账。nullable：老记录 / 无 requestId 的调用仍插新行。
     */
    requestId: text('requestId'),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('AiUsage_userId_period_idx').on(table.userId, table.periodMonth),
    index('AiUsage_userId_createdAt_idx').on(table.userId, table.createdAt),
    index('AiUsage_teamId_period_idx').on(table.teamId, table.periodMonth),
    index('AiUsage_promptHash_idx').on(table.promptHash, table.userId),
    index('AiUsage_createdAt_retention_idx').on(table.createdAt),
    // requestId upsert 的唯一约束。普通（非部分）唯一索引：标准 Postgres 把多个 NULL 视为互不
    // 相等 → 无 requestId 的老记录/调用仍可多行；且 ON CONFLICT ("requestId") 可直接用于 upsert
    // （部分索引的 ON CONFLICT 需重复 WHERE 谓词，drizzle 支持不佳且易错）。
    uniqueIndex('AiUsage_requestId_unique').on(table.requestId),
  ]
);

/**
 * 用户 BYOK key 绑定（pgcrypto 加密存储）
 *
 * 安全约束：
 *   - 字段名不暴露 provider（aiK1 而非 openAiKey），防 SQL dump 推断
 *   - 加密用 pgp_sym_encrypt，主密钥来自 env AI_KEY_ENCRYPTION_SECRET（Vault 注入）
 *   - keyHint 仅存后 4 位明文，UI 显示时用
 */
export const aiKeyBindings = pgTable(
  'AiKeyBinding',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('userId').notNull(),
    /** openai / anthropic / vertex */
    provider: text('provider').notNull(),
    /** 加密后的 key（pgp_sym_encrypt 输出 bytea，Drizzle 用 customType 映射；这里用 text 简化）*/
    encryptedKey: text('encryptedKey').notNull(),
    /** 后 4 位明文，UI 显示用 */
    keyHint: text('keyHint').notNull(),
    /** 是否启用（用户可临时停用而不删除） */
    active: boolean('active').notNull().default(true),
    /** 上次真实推理使用时间（用户拿此 key 真的调了 LLM）。dashboard "最近使用" 读此字段。
     *  只由 recordAiUsage 在 BYOK 成功推理时 stamp，不含 healthcheck ping。 */
    lastUsedAt: timestamp('lastUsedAt', { mode: 'date' }),
    /** 上次健康检查成功 ping 时间（cron，非真实推理）。与 lastUsedAt 语义拆分，避免 ping 冒充使用。 */
    lastCheckedAt: timestamp('lastCheckedAt', { mode: 'date' }),
    /** 上次失败原因（如 401 → 用户 key 已被 OpenAI 撤销） */
    lastErrorAt: timestamp('lastErrorAt', { mode: 'date' }),
    lastError: text('lastError'),
    /** 自定义 provider API base URL（如自建代理/OpenAI 兼容端点）。null=用 aster-api 内置默认。
     *  ⚠️ enforcement 需 aster-api 后端配套（当前 byok-envelope 不带 baseUrl）——本列先存储/显示。 */
    providerUrl: text('providerUrl'),
    /** BYOK 月度 token 上限（prompt+completion）。null=无限（保持历史「BYOK unlimited」语义）。 */
    tokenQuota: integer('tokenQuota'),
    /** key 失效日期。过期后推理层拒用该 BYOK key。null=永不过期。 */
    expiresAt: timestamp('expiresAt', { mode: 'date' }),
    /**
     * 同 provider 多 key 的调用优先级（数值**小**=优先级**高**，先被推理层选中）。
     *
     * 多 key（ADR：BYOK 优先级 fallback）：一个用户同一 provider 可绑多个 key，推理层按
     * priority asc 取第一个「active 且未过期且未超额」的 key（selection-time fallback，不做
     * 运行时重试）。同 priority 用 createdAt asc 兜底稳定排序。默认 0——历史单 key 行迁移后
     * 全为 0，退化为「任取唯一一个」，行为不变。
     */
    priority: integer('priority').notNull().default(0),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    // 多 key：去掉 (userId,provider) 唯一约束（一个 provider 现在可有多个 key）。
    // 选择索引覆盖推理层排序谓词：按 (userId,provider,priority) 取最高优先级可用 key。
    index('AiKey_userId_provider_priority_idx').on(
      table.userId,
      table.provider,
      table.priority,
    ),
    index('AiKey_active_idx').on(table.active),
  ]
);

// users 表 v1.2 加禁用字段（防盗刷自动封禁用）
// 注意：因为不想破坏已有 users 表 schema，把禁用字段直接加在 users 同一文件
// 在现有 users 表定义末尾追加（已在 priceLockedAt / legacyTier 旁边）

// ============================================
// License v2 / Revocation
// ============================================

/**
 * On-prem license verification cache（单行表 id='current'）。
 *
 * 设计意图：
 *   - 每个 on-prem 部署只追踪 *自己* 的 license，不存别人的
 *   - SaaS 模式下表存在但不写入，保持两种部署 schema 一致
 *   - check 约束强制 id='current'，防止意外写入多行
 */
export const licenseCache = pgTable(
  'LicenseCache',
  {
    id: text('id').primaryKey().notNull().default('current'),
    licenseId: text('license_id').notNull(),
    licenseKeyHash: text('license_key_hash').notNull(),
    payloadJson: jsonb('payload_json').notNull(),
    signingKeyId: text('signing_key_id').notNull(),
    verifiedAt: timestamp('verified_at', { mode: 'date', withTimezone: true }).notNull(),
    revocationVersion: bigint('revocation_version', { mode: 'bigint' }),
    revocationPublishedAt: timestamp('revocation_published_at', {
      mode: 'date',
      withTimezone: true,
    }),
    revocationFetchedAt: timestamp('revocation_fetched_at', {
      mode: 'date',
      withTimezone: true,
    }),
    lastSuccessfulRevocationCheckAt: timestamp('last_successful_revocation_check_at', {
      mode: 'date',
      withTimezone: true,
    }),
    lastRevocationError: jsonb('last_revocation_error'),
    isRevoked: boolean('is_revoked').default(false).notNull(),
    revokedAt: timestamp('revoked_at', { mode: 'date', withTimezone: true }),
    revokedReason: text('revoked_reason'),
    // 续费提醒幂等记录（PR-C）：{ version: 'signingKeyId:verifiedAtIso', thresholds: { '14': iso } }
    renewalNotifyRecord: jsonb('renewal_notify_record').default({}).notNull(),
    // 最近一次 telemetry 上传记录（G）：{ payload, attemptedAt, outcome, ingestId? }
    // 让 admin/license 页面有"我们上次发了什么"的透明视图。null = 未启用 / 未上传过。
    lastTelemetryUpload: jsonb('last_telemetry_upload'),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [check('LicenseCache_id_current_check', sql`${table.id} = 'current'`)]
);

/**
 * SaaS revocation 源表。
 *
 * 设计意图：
 *   - 只存 opaque licenseId + 运维原因，不存客户身份信息
 *   - 发布器按 revoked_at 排序合成签名 revocation.json
 *   - on-prem 端只通过签名 JSON 拉取，不直接读这张表
 */
export const revokedLicenses = pgTable(
  'RevokedLicense',
  {
    licenseId: text('license_id').primaryKey().notNull(),
    revokedAt: timestamp('revoked_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    revokedBy: text('revoked_by').notNull(),
    reason: text('reason').notNull(),
    notes: text('notes'),
    customerRef: text('customer_ref'),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index('RevokedLicense_revokedAt_idx').on(table.revokedAt)]
);

/**
 * 不可变 revocation publications。
 *
 * version 由 PR-L7 的 publisher 单调递增分配；当前仅用 check 约束确保正整数。
 * 索引按 published_at desc 加速"最新版"查询。
 *
 * mode='bigint'（codex Minor-7）：version 是 anti-rollback 数值，必须支持
 * 64-bit 精度。Number.MAX_SAFE_INTEGER 也够用，但 bigint 更明确表达意图，
 * 避免日后超过 2^53 时静默 truncate。
 */
export const revocationPublications = pgTable(
  'RevocationPublication',
  {
    version: bigint('version', { mode: 'bigint' }).primaryKey().notNull(),
    publishedAt: timestamp('published_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    validUntil: timestamp('valid_until', { mode: 'date', withTimezone: true }).notNull(),
    revokedCount: integer('revoked_count').notNull(),
    signedDoc: text('signed_doc').notNull(),
    signature: text('signature').notNull(),
  },
  (table) => [
    index('RevocationPub_publishedAt_idx').on(desc(table.publishedAt)),
    check(
      'RevocationPublication_version_positive_check',
      sql`${table.version} > 0`,
    ),
    check(
      'RevocationPublication_revoked_count_nonnegative_check',
      sql`${table.revokedCount} >= 0`,
    ),
  ]
);

// ============================================
// Renewal portal (v3) — see ADR + drizzle 0013/0014
// ============================================

// Hash-only token store (plaintext never persisted). One row per renewal
// invitation; ops uses token to reach /renew/<token> which kicks off
// Stripe checkout. After checkout success the row's consumedAt is stamped.
export const renewalTokens = pgTable(
  'RenewalToken',
  {
    tokenHash: text('token_hash').primaryKey().notNull(),
    licenseId: text('license_id').notNull(),
    customer: text('customer').notNull(),
    oldDeploymentBinding: jsonb('old_deployment_binding').notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
    emailSentAt: timestamp('email_sent_at', { mode: 'date', withTimezone: true }),
    consumedAt: timestamp('consumed_at', { mode: 'date', withTimezone: true }),
  },
  (table) => [
    index('RenewalToken_license_expires_idx').on(table.licenseId, desc(table.expiresAt)),
    index('RenewalToken_expires_idx').on(table.expiresAt),
  ]
);

// Opt-in usage telemetry from on-prem deployments. Aggregate only — no
// PII / no event content. Driven by ASTER_TELEMETRY_OPT_IN=1 + a
// shared secret issued at sign time. Used at renewal review to ground
// pricing / tier conversations in actual usage.
export const licenseTelemetry = pgTable(
  'LicenseTelemetry',
  {
    id: text('id').primaryKey().notNull(),
    licenseId: text('license_id').notNull(),
    deploymentId: text('deployment_id').notNull(),
    customer: text('customer').notNull(),
    periodStart: timestamp('period_start', { mode: 'date', withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { mode: 'date', withTimezone: true }).notNull(),
    payload: jsonb('payload').notNull(),
    receivedAt: timestamp('received_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    sourceIp: text('source_ip'),
    signatureKid: text('signature_kid').notNull(),
    signatureAlg: text('signature_alg').notNull(),
    signatureB64: text('signature_b64').notNull(),
    /**
     * GDPR Art 44 evidence: which SaaS region accepted/stored this row
     * (us / eu / apac / unknown for pre-J2 rows). Set from
     * ASTER_DATA_REGION env at ingest time.
     */
    dataRegion: text('data_region'),
  },
  (table) => [
    index('LicenseTelemetry_license_received_idx').on(
      table.licenseId,
      desc(table.receivedAt),
    ),
    index('LicenseTelemetry_received_idx').on(table.receivedAt),
    index('LicenseTelemetry_customer_received_idx').on(
      table.customer,
      desc(table.receivedAt),
    ),
  ]
);

// Access + deletion audit for LicenseTelemetry rows.
// SOC 2 CC6.1 / ISO 27001 A.12.4.1 require recording who-touched-what-when
// on personal-context data. Reads kept 90d, deletes kept 7y (legal hold).
export const telemetryAccessAudit = pgTable(
  'TelemetryAccessAudit',
  {
    id: text('id').primaryKey().notNull(),
    at: timestamp('at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
    action: text('action').notNull(),
    actorId: text('actor_id').notNull(),
    actorEmail: text('actor_email'),
    subjectKind: text('subject_kind').notNull(),
    subjectKey: text('subject_key').notNull(),
    metadata: jsonb('metadata'),
    requestId: text('request_id'),
  },
  (table) => [
    index('TelemetryAccessAudit_at_idx').on(desc(table.at)),
    index('TelemetryAccessAudit_subject_idx').on(table.subjectKind, table.subjectKey),
    index('TelemetryAccessAudit_actor_idx').on(table.actorId, desc(table.at)),
  ]
);

// Audit trail of every license ever signed. License key bytes are not
// stored (show-once contract); we keep enough metadata to drive lifecycle
// + ops UI + replay reconstruction.
export const issuedLicenses = pgTable(
  'IssuedLicense',
  {
    licenseId: text('license_id').primaryKey().notNull(),
    customer: text('customer').notNull(),
    deploymentBinding: jsonb('deployment_binding').notNull(),
    payloadJson: jsonb('payload_json').notNull(),
    payloadHash: text('payload_hash').notNull(),
    signingKeyId: text('signing_key_id').notNull(),
    signedAt: timestamp('signed_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
    tier: text('tier').notNull(),
    licenseTerm: text('license_term').notNull(),
    stripeSubscriptionId: text('stripe_subscription_id'),
    stripeCheckoutSessionId: text('stripe_checkout_session_id'),
    renewedFromLicenseId: text('renewed_from_license_id'),
    supersededAt: timestamp('superseded_at', { mode: 'date', withTimezone: true }),
    supersededBy: text('superseded_by'),
  },
  (table) => [
    index('IssuedLicense_stripe_session_idx').on(table.stripeCheckoutSessionId),
    index('IssuedLicense_stripe_subscription_idx').on(table.stripeSubscriptionId),
    index('IssuedLicense_customer_expires_idx').on(table.customer, desc(table.expiresAt)),
    index('IssuedLicense_renewed_from_idx').on(table.renewedFromLicenseId),
    // Partial index for the overlap-expiry cron: rows pending supersede
    index('IssuedLicense_pending_supersede_idx').on(
      table.supersededBy,
      table.expiresAt,
    ),
  ]
);

// ============================================
// Relations
// ============================================

export const usersRelations = relations(users, ({ many }) => ({
  accounts: many(accounts),
  sessions: many(sessions),
  apiKeys: many(apiKeys),
  policies: many(policies),
  policyGroups: many(policyGroups),
  executions: many(executions),
  usageRecords: many(usageRecords),
  teamMembers: many(teamMembers),
  ownedTeams: many(teams),
  userDomainTerms: many(userDomainTerms),
  structuralAliasGrants: many(structuralAliasGrants, {
    relationName: 'StructuralAliasGrantUser',
  }),
  grantedStructuralAliasGrants: many(structuralAliasGrants, {
    relationName: 'StructuralAliasGrantAdmin',
  }),
}));

export const structuralAliasGrantRelations = relations(structuralAliasGrants, ({ one }) => ({
  user: one(users, {
    fields: [structuralAliasGrants.userId],
    references: [users.id],
    relationName: 'StructuralAliasGrantUser',
  }),
  grantor: one(users, {
    fields: [structuralAliasGrants.grantedBy],
    references: [users.id],
    relationName: 'StructuralAliasGrantAdmin',
  }),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, {
    fields: [apiKeys.userId],
    references: [users.id],
  }),
}));

export const policyGroupsRelations = relations(policyGroups, ({ one, many }) => ({
  parent: one(policyGroups, {
    fields: [policyGroups.parentId],
    references: [policyGroups.id],
    relationName: 'GroupHierarchy',
  }),
  children: many(policyGroups, { relationName: 'GroupHierarchy' }),
  policies: many(policies),
  user: one(users, {
    fields: [policyGroups.userId],
    references: [users.id],
  }),
  team: one(teams, {
    fields: [policyGroups.teamId],
    references: [teams.id],
  }),
}));

export const policiesRelations = relations(policies, ({ one, many }) => ({
  user: one(users, {
    fields: [policies.userId],
    references: [users.id],
  }),
  team: one(teams, {
    fields: [policies.teamId],
    references: [teams.id],
  }),
  group: one(policyGroups, {
    fields: [policies.groupId],
    references: [policyGroups.id],
  }),
  executions: many(executions),
  versions: many(policyVersions),
  recycleBin: one(policyRecycleBins),
}));

export const policyVersionsRelations = relations(policyVersions, ({ one, many }) => ({
  policy: one(policies, {
    fields: [policyVersions.policyId],
    references: [policies.id],
  }),
  approvals: many(policyApprovals),
  // 「谁做的」三个字段存的是 User.id（**刻意存 ID 不存姓名**：不可变记录不能因用户
  // 改名而漂移，与审计链同口径）。展示层要显示姓名就必须在读取时 join 出来——
  // 此前没有这层 relation，版本详情面板于是直接渲染裸 UUID。
  createdByUser: one(users, {
    fields: [policyVersions.createdBy],
    references: [users.id],
    relationName: 'policyVersionCreatedBy',
  }),
  deprecatedByUser: one(users, {
    fields: [policyVersions.deprecatedBy],
    references: [users.id],
    relationName: 'policyVersionDeprecatedBy',
  }),
  archivedByUser: one(users, {
    fields: [policyVersions.archivedBy],
    references: [users.id],
    relationName: 'policyVersionArchivedBy',
  }),
}));

export const policyApprovalsRelations = relations(policyApprovals, ({ one }) => ({
  version: one(policyVersions, {
    fields: [policyApprovals.versionId],
    references: [policyVersions.id],
  }),
  // 同 policyVersions 的三个 actor：存 ID，展示时 join 出姓名。
  approverUser: one(users, {
    fields: [policyApprovals.approverId],
    references: [users.id],
    relationName: 'policyApprovalApprover',
  }),
}));

export const policyRecycleBinsRelations = relations(policyRecycleBins, ({ one }) => ({
  policy: one(policies, {
    fields: [policyRecycleBins.policyId],
    references: [policies.id],
  }),
}));

export const executionsRelations = relations(executions, ({ one }) => ({
  user: one(users, {
    fields: [executions.userId],
    references: [users.id],
  }),
  policy: one(policies, {
    fields: [executions.policyId],
    references: [policies.id],
  }),
}));

export const usageRecordsRelations = relations(usageRecords, ({ one }) => ({
  user: one(users, {
    fields: [usageRecords.userId],
    references: [users.id],
  }),
}));

export const teamsRelations = relations(teams, ({ one, many }) => ({
  owner: one(users, {
    fields: [teams.ownerId],
    references: [users.id],
  }),
  members: many(teamMembers),
  policies: many(policies),
  policyGroups: many(policyGroups),
  invitations: many(teamInvitations),
  userDomainTerms: many(userDomainTerms),
}));

export const teamMembersRelations = relations(teamMembers, ({ one }) => ({
  team: one(teams, {
    fields: [teamMembers.teamId],
    references: [teams.id],
  }),
  user: one(users, {
    fields: [teamMembers.userId],
    references: [users.id],
  }),
}));

export const teamInvitationsRelations = relations(teamInvitations, ({ one }) => ({
  team: one(teams, {
    fields: [teamInvitations.teamId],
    references: [teams.id],
  }),
}));

export const demoSessionsRelations = relations(demoSessions, ({ many }) => ({
  policies: many(demoPolicies),
  executions: many(demoExecutions),
  auditLogs: many(demoAuditLogs),
}));

export const demoPoliciesRelations = relations(demoPolicies, ({ one, many }) => ({
  session: one(demoSessions, {
    fields: [demoPolicies.sessionId],
    references: [demoSessions.id],
  }),
  versions: many(demoPolicyVersions),
  executions: many(demoExecutions),
}));

export const demoPolicyVersionsRelations = relations(demoPolicyVersions, ({ one }) => ({
  policy: one(demoPolicies, {
    fields: [demoPolicyVersions.policyId],
    references: [demoPolicies.id],
  }),
}));

export const demoExecutionsRelations = relations(demoExecutions, ({ one }) => ({
  session: one(demoSessions, {
    fields: [demoExecutions.sessionId],
    references: [demoSessions.id],
  }),
  policy: one(demoPolicies, {
    fields: [demoExecutions.policyId],
    references: [demoPolicies.id],
  }),
}));

export const demoAuditLogsRelations = relations(demoAuditLogs, ({ one }) => ({
  session: one(demoSessions, {
    fields: [demoAuditLogs.sessionId],
    references: [demoSessions.id],
  }),
}));

// ============================================
// TypeScript Types (替代 @prisma/client 类型)
// ============================================

// Enum 类型导出
export type Plan = (typeof planEnum.enumValues)[number];
export type SubscriptionStatus = (typeof subscriptionStatusEnum.enumValues)[number];
export type PolicyVersionStatus = (typeof policyVersionStatusEnum.enumValues)[number];
export type ApprovalDecision = (typeof approvalDecisionEnum.enumValues)[number];
export type SecurityEventType = (typeof securityEventTypeEnum.enumValues)[number];
export type EventSeverity = (typeof eventSeverityEnum.enumValues)[number];
export type ExecutionSource = (typeof executionSourceEnum.enumValues)[number];
export type UsageType = (typeof usageTypeEnum.enumValues)[number];
export type TeamRole = (typeof teamRoleEnum.enumValues)[number];
export type ComplianceType = (typeof complianceTypeEnum.enumValues)[number];
export type ReportStatus = (typeof reportStatusEnum.enumValues)[number];

// 表类型导出（InferSelectModel 和 InferInsertModel）
import { type InferSelectModel, type InferInsertModel } from 'drizzle-orm';

export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;

export type Account = InferSelectModel<typeof accounts>;
export type NewAccount = InferInsertModel<typeof accounts>;

export type Session = InferSelectModel<typeof sessions>;
export type NewSession = InferInsertModel<typeof sessions>;

export type Policy = InferSelectModel<typeof policies>;
export type NewPolicy = InferInsertModel<typeof policies>;

export type PolicyVersion = InferSelectModel<typeof policyVersions>;
export type NewPolicyVersion = InferInsertModel<typeof policyVersions>;

export type PolicyApproval = InferSelectModel<typeof policyApprovals>;
export type NewPolicyApproval = InferInsertModel<typeof policyApprovals>;

export type PolicyGroup = InferSelectModel<typeof policyGroups>;
export type NewPolicyGroup = InferInsertModel<typeof policyGroups>;

export type Execution = InferSelectModel<typeof executions>;
export type NewExecution = InferInsertModel<typeof executions>;

// P0-A 回归工具（ADR 0030 M1）。
export type RegressionCase = InferSelectModel<typeof regressionCases>;
export type NewRegressionCase = InferInsertModel<typeof regressionCases>;
export type RegressionReport = InferSelectModel<typeof regressionReports>;
export type NewRegressionReport = InferInsertModel<typeof regressionReports>;
export type RegressionDriftApproval = InferSelectModel<typeof regressionDriftApprovals>;
export type NewRegressionDriftApproval = InferInsertModel<typeof regressionDriftApprovals>;
export type RegressionUpgradeManifest = InferSelectModel<typeof regressionUpgradeManifests>;
export type NewRegressionUpgradeManifest = InferInsertModel<typeof regressionUpgradeManifests>;

export type Team = InferSelectModel<typeof teams>;
export type NewTeam = InferInsertModel<typeof teams>;

export type TeamMember = InferSelectModel<typeof teamMembers>;
export type NewTeamMember = InferInsertModel<typeof teamMembers>;

export type TeamInvitation = InferSelectModel<typeof teamInvitations>;
export type NewTeamInvitation = InferInsertModel<typeof teamInvitations>;

export type Notification = InferSelectModel<typeof notifications>;
export type NewNotification = InferInsertModel<typeof notifications>;

export type PlatformSetting = InferSelectModel<typeof platformSettings>;
export type NewPlatformSetting = InferInsertModel<typeof platformSettings>;

export type PolicyShare = InferSelectModel<typeof policyShares>;
export type NewPolicyShare = InferInsertModel<typeof policyShares>;

export type ApiKey = InferSelectModel<typeof apiKeys>;
export type NewApiKey = InferInsertModel<typeof apiKeys>;

export type UsageRecord = InferSelectModel<typeof usageRecords>;
export type NewUsageRecord = InferInsertModel<typeof usageRecords>;

export type SecurityEvent = InferSelectModel<typeof securityEvents>;
export type NewSecurityEvent = InferInsertModel<typeof securityEvents>;

export type ComplianceReport = InferSelectModel<typeof complianceReports>;
export type NewComplianceReport = InferInsertModel<typeof complianceReports>;

export type AuditLog = InferSelectModel<typeof auditLogs>;
export type NewAuditLog = InferInsertModel<typeof auditLogs>;

export type LicenseCache = InferSelectModel<typeof licenseCache>;
export type NewLicenseCache = InferInsertModel<typeof licenseCache>;

export type RevokedLicense = InferSelectModel<typeof revokedLicenses>;
export type NewRevokedLicense = InferInsertModel<typeof revokedLicenses>;

export type RevocationPublication = InferSelectModel<typeof revocationPublications>;
export type NewRevocationPublication = InferInsertModel<typeof revocationPublications>;

export type RenewalToken = InferSelectModel<typeof renewalTokens>;
export type NewRenewalToken = InferInsertModel<typeof renewalTokens>;

export type IssuedLicense = InferSelectModel<typeof issuedLicenses>;
export type NewIssuedLicense = InferInsertModel<typeof issuedLicenses>;

export type LicenseTelemetry = InferSelectModel<typeof licenseTelemetry>;
export type NewLicenseTelemetry = InferInsertModel<typeof licenseTelemetry>;

export type TelemetryAccessAudit = InferSelectModel<typeof telemetryAccessAudit>;
export type NewTelemetryAccessAudit = InferInsertModel<typeof telemetryAccessAudit>;

// CronJobLease — mutex for any cron job that can be triggered from
// more than one place (Cloudflare Workers scheduled() + external HTTP
// callers + manual ops curl). The `(job_name, window_start)` unique
// constraint plus an INSERT…ON CONFLICT DO NOTHING acquire makes the
// "first writer wins" semantics atomic at the DB layer; we don't need
// distributed locks or extra coordination.
//
// `status` evolves: 'running' (acquired) → 'done' | 'failed'. Both
// terminal states are kept in-table for a short retention window so
// ops can read "did the 04:30 user-purge happen?" without parsing
// Worker logs. A periodic GC drops rows past `LEASE_RETENTION_DAYS`.
export const cronJobLease = pgTable(
  'CronJobLease',
  {
    id: text('id').primaryKey().notNull(),
    jobName: text('job_name').notNull(),
    windowStart: timestamp('window_start', { mode: 'date', withTimezone: true }).notNull(),
    acquiredAt: timestamp('acquired_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    acquiredBy: text('acquired_by').notNull(),
    completedAt: timestamp('completed_at', { mode: 'date', withTimezone: true }),
    status: text('status').notNull(),
    errorMessage: text('error_message'),
  },
  (table) => [
    uniqueIndex('CronJobLease_job_window_unique').on(table.jobName, table.windowStart),
    index('CronJobLease_status_idx').on(table.status, desc(table.acquiredAt)),
    index('CronJobLease_acquired_at_idx').on(desc(table.acquiredAt)),
  ]
);

export type CronJobLease = InferSelectModel<typeof cronJobLease>;
export type NewCronJobLease = InferInsertModel<typeof cronJobLease>;

// User-managed Domain Vocabularies (B1 of user-domain-vocabulary plan).
//
// Three-table model:
//   - DomainTerm: global deduplicated catalogue. Never mutated by user edits;
//     a modify operation creates a new row (if needed) and repoints the link.
//   - UserDomainTerm: per-user active link with soft-delete + 90-day archive.
//     v1 enforces ownerType='user'; teamId reserved for v2 team-shared vocab.
//   - UserVocabularySnapshot: publish-time frozen content, ref-counted,
//     content-hash deduped. policyVersions.vocabularySnapshotIds points here
//     so rollback can reproduce the exact term set used to compile a version.

export const domainTerms = pgTable(
  'DomainTerm',
  {
    id: text('id').primaryKey().notNull(),
    domain: text('domain').notNull(),
    locale: text('locale').notNull(),
    kind: text('kind').notNull(),
    canonical: text('canonical').notNull(),
    canonicalNorm: text('canonicalNorm').notNull(),
    localized: text('localized').notNull(),
    localizedNorm: text('localizedNorm').notNull(),
    parentCanonical: text('parentCanonical'),
    parentCanonicalNorm: text('parentCanonicalNorm'),
    description: text('description'),
    aliases: jsonb('aliases').$type<string[]>().default([]).notNull(),
    source: text('source').notNull(),
    status: text('status').default('active').notNull(),
    version: integer('version').default(1).notNull(),
    dedupKey: text('dedupKey').notNull(),
    createdAt: timestamp('createdAt', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updatedAt', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    deprecatedAt: timestamp('deprecatedAt', { mode: 'date', withTimezone: true }),
    deprecatedReason: text('deprecatedReason'),
  },
  (table) => [
    check(
      'DomainTerm_kind_check',
      sql`${table.kind} IN ('struct', 'field', 'function', 'enum_value')`,
    ),
    check(
      'DomainTerm_source_check',
      sql`${table.source} IN ('builtin', 'user', 'admin_seed')`,
    ),
    check(
      'DomainTerm_status_check',
      sql`${table.status} IN ('active', 'deprecated')`,
    ),
    uniqueIndex('DomainTerm_dedupKey_unique').on(table.dedupKey),
    index('DomainTerm_domain_locale_kind_idx').on(table.domain, table.locale, table.kind),
    index('DomainTerm_status_idx').on(table.status),
    index('DomainTerm_canonicalNorm_idx').on(table.canonicalNorm),
    index('DomainTerm_localizedNorm_idx').on(table.localizedNorm),
  ]
);

export type DomainTerm = InferSelectModel<typeof domainTerms>;
export type NewDomainTerm = InferInsertModel<typeof domainTerms>;

// UserVocabularySnapshot declared before UserDomainTerm because the link
// table FKs into the snapshot for its archiveSnapshotId column.
export const userVocabularySnapshots = pgTable(
  'UserVocabularySnapshot',
  {
    id: text('id').primaryKey().notNull(),
    ownerType: text('ownerType').notNull(),
    ownerId: text('ownerId').notNull(),
    domain: text('domain').notNull(),
    locale: text('locale').notNull(),
    version: integer('version').notNull(),
    vocabularyJson: jsonb('vocabularyJson').notNull(),
    termIds: jsonb('termIds').$type<string[]>().notNull(),
    contentHash: text('contentHash').notNull(),
    refCount: integer('refCount').default(0).notNull(),
    createdAt: timestamp('createdAt', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    archivedAt: timestamp('archivedAt', { mode: 'date', withTimezone: true }),
  },
  (table) => [
    check(
      'UserVocabularySnapshot_ownerType_check',
      sql`${table.ownerType} IN ('user', 'team')`,
    ),
    check(
      'UserVocabularySnapshot_refCount_check',
      sql`${table.refCount} >= 0`,
    ),
    uniqueIndex('UserVocabularySnapshot_owner_version_unique').on(
      table.ownerType,
      table.ownerId,
      table.domain,
      table.locale,
      table.version,
    ),
    uniqueIndex('UserVocabularySnapshot_owner_hash_unique').on(
      table.ownerType,
      table.ownerId,
      table.domain,
      table.locale,
      table.contentHash,
    ),
    index('UserVocabularySnapshot_refCount_idx').on(table.refCount),
  ]
);

export type UserVocabularySnapshot = InferSelectModel<typeof userVocabularySnapshots>;
export type NewUserVocabularySnapshot = InferInsertModel<typeof userVocabularySnapshots>;

export const userDomainTerms = pgTable(
  'UserDomainTerm',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    termId: text('termId')
      .notNull()
      .references(() => domainTerms.id, { onDelete: 'restrict' }),
    ownerType: text('ownerType').default('user').notNull(),
    teamId: text('teamId').references(() => teams.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    locale: text('locale').notNull(),
    kind: text('kind').notNull(),
    note: text('note'),
    createdAt: timestamp('createdAt', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updatedAt', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp('deletedAt', { mode: 'date', withTimezone: true }),
    deletedBy: text('deletedBy'),
    deletedReason: text('deletedReason'),
    archivedAt: timestamp('archivedAt', { mode: 'date', withTimezone: true }),
    archiveSnapshotId: text('archiveSnapshotId').references(
      () => userVocabularySnapshots.id,
    ),
  },
  (table) => [
    check(
      'UserDomainTerm_owner_v1_check',
      sql`${table.ownerType} = 'user' AND ${table.userId} IS NOT NULL AND ${table.teamId} IS NULL`,
    ),
    uniqueIndex('UserDomainTerm_active_unique')
      .on(table.userId, table.termId)
      .where(sql`${table.deletedAt} IS NULL AND ${table.archivedAt} IS NULL`),
    index('UserDomainTerm_user_domain_idx')
      .on(table.userId, table.domain, table.locale)
      .where(sql`${table.deletedAt} IS NULL AND ${table.archivedAt} IS NULL`),
    index('UserDomainTerm_termId_idx')
      .on(table.termId)
      .where(sql`${table.deletedAt} IS NULL AND ${table.archivedAt} IS NULL`),
    index('UserDomainTerm_archive_idx').on(table.archivedAt, table.deletedAt),
  ]
);

export type UserDomainTerm = InferSelectModel<typeof userDomainTerms>;
export type NewUserDomainTerm = InferInsertModel<typeof userDomainTerms>;

export const domainTermRelations = relations(domainTerms, ({ many }) => ({
  userDomainTerms: many(userDomainTerms),
}));

export const userDomainTermRelations = relations(userDomainTerms, ({ one }) => ({
  user: one(users, {
    fields: [userDomainTerms.userId],
    references: [users.id],
  }),
  term: one(domainTerms, {
    fields: [userDomainTerms.termId],
    references: [domainTerms.id],
  }),
  team: one(teams, {
    fields: [userDomainTerms.teamId],
    references: [teams.id],
  }),
  archiveSnapshot: one(userVocabularySnapshots, {
    fields: [userDomainTerms.archiveSnapshotId],
    references: [userVocabularySnapshots.id],
  }),
}));

export const userVocabularySnapshotRelations = relations(
  userVocabularySnapshots,
  ({ many }) => ({
    archivedUserDomainTerms: many(userDomainTerms),
  }),
);

// Lexicon mutation idempotency cache.
//
// Route handlers use this table to make Idempotency-Key retries safe for
// user-domain-vocabulary mutations. A duplicate (userId, routeKey,
// idempotencyKey) with a matching requestHash replays the stored response;
// the same key with a different requestHash is a client error. expiresAt is
// swept by a follow-up retention/GC worker (B13).
export const lexiconIdempotencyKeys = pgTable(
  'LexiconIdempotencyKey',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotencyKey').notNull(),
    routeKey: text('routeKey').notNull(),
    requestHash: text('requestHash').notNull(),
    responseStatus: integer('responseStatus').notNull(),
    responseBody: jsonb('responseBody').notNull(),
    createdAt: timestamp('createdAt', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp('expiresAt', { mode: 'date', withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('LexiconIdempotencyKey_user_route_key_unique').on(
      table.userId,
      table.routeKey,
      table.idempotencyKey,
    ),
    index('LexiconIdempotencyKey_expiresAt_idx').on(table.expiresAt),
  ]
);

export type LexiconIdempotencyKey = InferSelectModel<typeof lexiconIdempotencyKeys>;
export type NewLexiconIdempotencyKey = InferInsertModel<typeof lexiconIdempotencyKeys>;

// Bulk vocabulary import jobs.
//
// Sync imports write a completed row at request time for auditability. Async
// imports enqueue a queued row that the bulk worker claims via the
// (status, createdAt) index, transitioning queued → running → terminal.
// Partial unique on (userId, idempotencyKey) WHERE idempotencyKey IS NOT NULL
// makes Idempotency-Key replay safe without forcing a key on every submission.
export const lexiconBulkJobs = pgTable(
  'LexiconBulkJob',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotencyKey'),
    status: text('status').default('queued').notNull(),
    mode: text('mode').notNull(),
    rowCount: integer('rowCount').notNull(),
    processed: integer('processed').default(0).notNull(),
    rollup: jsonb('rollup')
      .$type<{
        added?: number;
        reused?: number;
        modified?: number;
        skipped?: number;
        errorCount?: number;
      }>()
      .default({})
      .notNull(),
    errors: jsonb('errors')
      .$type<Array<{ row: number; code: string; message: string }>>()
      .default([])
      .notNull(),
    // Stored term payload for async jobs. Sync jobs leave this NULL because
    // the import was processed inline.
    inputJson: jsonb('inputJson').$type<Array<unknown>>(),
    claimedBy: text('claimedBy'),
    claimedAt: timestamp('claimedAt', { mode: 'date', withTimezone: true }),
    completedAt: timestamp('completedAt', { mode: 'date', withTimezone: true }),
    createdAt: timestamp('createdAt', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updatedAt', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      'LexiconBulkJob_status_check',
      sql`${table.status} IN ('queued', 'running', 'completed', 'failed', 'cancelled')`,
    ),
    check(
      'LexiconBulkJob_mode_check',
      sql`${table.mode} IN ('sync', 'async')`,
    ),
    // rowCount > 0: empty uploads are caller-side errors and should not
    // create job rows. processed bounded by [0, rowCount] keeps progress
    // monotonic. rollup must be a jsonb object and errors a jsonb array
    // so the progress UI can blindly destructure either field.
    check(
      'LexiconBulkJob_processed_check',
      sql`${table.rowCount} > 0 AND ${table.processed} >= 0 AND ${table.processed} <= ${table.rowCount}`,
    ),
    check(
      'LexiconBulkJob_rollup_shape_check',
      sql`jsonb_typeof(${table.rollup}) = 'object'`,
    ),
    check(
      'LexiconBulkJob_errors_shape_check',
      sql`jsonb_typeof(${table.errors}) = 'array'`,
    ),
    index('LexiconBulkJob_userId_createdAt_idx').on(
      table.userId,
      desc(table.createdAt),
    ),
    index('LexiconBulkJob_status_createdAt_idx').on(table.status, table.createdAt),
    uniqueIndex('LexiconBulkJob_user_idem_unique')
      .on(table.userId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
  ]
);

export type LexiconBulkJob = InferSelectModel<typeof lexiconBulkJobs>;
export type NewLexiconBulkJob = InferInsertModel<typeof lexiconBulkJobs>;
