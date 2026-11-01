# SaaS-Only Asset Inventory (PR-0)

> 工作区：`/Users/rpang/IdeaProjects/aster-cloud`
> 日期：2026-05-18
> 用途：v2 计划 PR-0 产物 — 在动任何代码前，穷举所有 SaaS-only 资产作为审计基线
> **修订**：基于 codex MCP 审查（session `019e387c-0c75-7e51-bcbd-4dfb3e96a201`）补全 §7.5 团队邀请、§7.6 signup 风险链路、§8.5 UI affordances 表、§12 schema 分类
>
> **规则**：on-prem 构建必须从 bundle 中**消失**或返回 404 的所有资产，必须出现在本清单。后续 PR-4 / PR-5 / PR-7 的工作量直接对应本清单。
>
> **更新策略**：每次新增 SaaS-only 模块（如新接 Mixpanel 事件、新 Stripe webhook 处理器）必须同步更新本文件 + 更新对应 helper gate（`CAN_BILLING` / `CAN_MIXPANEL` / `CAN_RESEND` 等）。

---

## 0. 摘要

| 类别 | 数量 | 备注 |
|---|---|---|
| Pages（用户面） | 3 | `/pricing`、`/billing`、`/signup` |
| Pages（admin） | 1 | `/admin/risk-tier`（计划新增 `/admin/billing`） |
| API routes（Stripe） | 11 | 含 webhook 子处理器 |
| API routes（cron — SaaS only） | 7 | risk-tier、dunning、trial、reconcile 等 |
| API routes（cron — 共享） | 5 | nonce 清理、用户 purge 等两种模式都跑 |
| API routes（user） | 1 | `/api/user/dunning-status` |
| Libraries（heavy — pull SaaS SDK） | 7 | stripe.ts、mixpanel.ts、resend.ts、dunning.ts、email/、stripe-reconcile.ts、snapshot-pusher.ts |
| Libraries（plan/risk — 无外部 SDK） | 3 | plans.ts、risk-tier.ts、plan-gate-client.ts（保留，跨模式共用类型） |
| npm 依赖（SaaS-only） | 3 | `stripe`、`mixpanel-browser`、`resend` |
| Env vars（SaaS-only） | 10+ | `STRIPE_*`、`NEXT_PUBLIC_STRIPE_*_PRICE_ID`、`NEXT_PUBLIC_MIXPANEL_TOKEN`、`RESEND_API_KEY` |
| Env vars（On-prem 专属） | 2 | `LICENSE_KEY`、`SSO_PROVIDER` |
| DB 列（SaaS 语义） | 14 | 保留 schema，on-prem 不写 |
| Wrangler scheduled triggers | 2 | risk-tier-decay、user-purge（user-purge 共用） |

---

## 1. Pages（用户面）

| 路径 | 文件 | gate 常量 | 行为（on-prem） |
|---|---|---|---|
| `/pricing` | `src/app/[locale]/pricing/page.tsx` | `CAN_PRICING` | 404 |
| `/pricing` 内容 | `src/app/[locale]/pricing/pricing-content.tsx` | — | 由 page 守门 |
| `/billing` | `src/app/[locale]/(dashboard)/billing/page.tsx` | `CAN_BILLING` | 404 |
| `/billing` 内容 | `src/app/[locale]/(dashboard)/billing/billing-content.tsx` | — | 由 page 守门 |
| `/signup` | `src/app/[locale]/(auth)/signup/page.tsx`（已确认存在） | `CAN_SIGNUP` | 404 或 "Contact your administrator" |
| `/solutions/{insurance-rating,credit-decisions,agent-guardrails,eligibility-rules}` | `src/app/[locale]/solutions/*/page.tsx`（需求验证落地页，2026-11） | `IS_SAAS` | 404 |
| `POST /api/pilot-applications` | `src/app/api/pilot-applications/route.ts`（落地页试点申请） | `IS_SAAS` | 404 |

**marketing home `/`**：不 404，但用变体组件按模式渲染 hero（`SaasMarketingHero` vs `OnPremMarketingHero`）。

---

## 2. Pages（admin）

| 路径 | 文件 | gate 常量 | 行为（on-prem） |
|---|---|---|---|
| `/admin/risk-tier` | `src/app/[locale]/(dashboard)/admin/risk-tier/page.tsx` | `CAN_RISKTIER` | 404 |
| `/admin/risk-tier` 内容 | `src/app/[locale]/(dashboard)/admin/risk-tier/risk-tier-content.tsx` | — | 由 page 守门 |
| `/admin/ai-circuit-breaker` | `src/app/[locale]/(dashboard)/admin/ai-circuit-breaker/page.tsx` | **两种模式都有** | 200 |
| `/admin/demand` | `src/app/[locale]/(dashboard)/admin/demand/page.tsx`（需求验证看板 + 试点申请，2026-11） | `IS_SAAS` | 404 |
| `GET /api/admin/pilot-applications/export` | `src/app/api/admin/pilot-applications/export/route.ts` | `IS_SAAS` | 404 |
| `/admin/billing`（**未建**） | — | `CAN_BILLING` | 计划 PR-4 新增 |
| `/admin/license`（**未建**） | — | `CAN_LICENSE` | 占位页（PR-8） |
| `/admin/sso`（**未建**） | — | `CAN_SSO` | 占位页（PR-8） |
| `/admin/audit-log`（**未建**） | — | 两种模式都有 | 未来 PR |

---

## 3. API routes — Stripe（全部 SaaS-only）

| 路径 | 文件 | gate 常量 |
|---|---|---|
| `POST /api/stripe/webhook` | `src/app/api/stripe/webhook/route.ts` | `CAN_BILLING` |
| `POST /api/stripe/portal` | `src/app/api/stripe/portal/route.ts` | `CAN_BILLING` |
| `POST /api/stripe/checkout` | `src/app/api/stripe/checkout/route.ts` | `CAN_BILLING` |

**Webhook 子处理器**（由 webhook route 内部分发，本身不是独立路由 — 由 webhook 守门即可，不需各自 gate）：

- `src/app/api/stripe/webhook/handlers/_shared.ts`
- `src/app/api/stripe/webhook/handlers/checkout-completed.ts`
- `src/app/api/stripe/webhook/handlers/subscription-created.ts`
- `src/app/api/stripe/webhook/handlers/subscription-updated.ts`
- `src/app/api/stripe/webhook/handlers/subscription-deleted.ts`
- `src/app/api/stripe/webhook/handlers/subscription-trial-will-end.ts`
- `src/app/api/stripe/webhook/handlers/invoice-payment-succeeded.ts`
- `src/app/api/stripe/webhook/handlers/invoice-payment-failed.ts`
- `src/app/api/stripe/webhook/handlers/charge-dispute-created.ts`

---

## 4. API routes — Cron jobs

**SaaS-only**（on-prem 必须 404 + 从 `wrangler.toml` triggers 移除）：

| 路径 | 文件 | gate 常量 |
|---|---|---|
| `/api/cron/risk-tier-decay` | `src/app/api/cron/risk-tier-decay/route.ts` | `CAN_RISKTIER` |
| `/api/cron/dunning-emails` | `src/app/api/cron/dunning-emails/route.ts` | `CAN_DUNNING` |
| `/api/cron/trial-day-1-reminder` | `src/app/api/cron/trial-day-1-reminder/route.ts` | `CAN_BILLING` |
| `/api/cron/auto-downgrade` | `src/app/api/cron/auto-downgrade/route.ts` | `CAN_BILLING` |
| `/api/cron/reconcile-stripe-seats` | `src/app/api/cron/reconcile-stripe-seats/route.ts` | `CAN_BILLING` |
| `/api/cron/api-quota-alerts` | `src/app/api/cron/api-quota-alerts/route.ts` | `CAN_BILLING`（依赖 dunning email 通知） |
| `/api/cron/byok-healthcheck` | `src/app/api/cron/byok-healthcheck/route.ts` | `CAN_BILLING`（BYOK 是 SaaS Pro feature） |

**共享**（两种模式都跑，不加 gate）：

| 路径 | 文件 | 说明 |
|---|---|---|
| `/api/cron/user-purge` | `src/app/api/cron/user-purge/route.ts` | GDPR 30d 硬清理 — 两种模式都要 |
| `/api/cron/cleanup-nonces` | `src/app/api/cron/cleanup-nonces/route.ts` | NextAuth nonce GC — 两种都要 |
| `/api/cron/ai-circuit-check` | `src/app/api/cron/ai-circuit-check/route.ts` | AI cost circuit breaker — 两种都要 |
| `/api/cron/ai-audit-cleanup` | `src/app/api/cron/ai-audit-cleanup/route.ts` | AI 审计日志清理 — 两种都要 |
| `/api/cron/ai-anomaly-scan` | `src/app/api/cron/ai-anomaly-scan/route.ts` | AI 异常扫描 — 两种都要 |

---

## 5. API routes — User（计费相关）

| 路径 | 文件 | gate 常量 |
|---|---|---|
| `GET /api/user/dunning-status` | `src/app/api/user/dunning-status/route.ts` | `CAN_DUNNING` |

`/api/user/ai-usage`、`/api/user/api-usage` 共用（quota 概念在两种模式都需要，配额上限不同而已）。

---

## 6. API routes — Admin

| 路径 | 文件 | gate 常量 |
|---|---|---|
| `* /api/admin/risk-tier` | `src/app/api/admin/risk-tier/route.ts` | `CAN_RISKTIER` |
| `* /api/admin/ai-circuit-breaker` | `src/app/api/admin/ai-circuit-breaker/route.ts` | **两种模式都有** |

---

## 6.5 API routes — Team invitations（codex C2 / M1 补漏）

| 路径 | 文件 | 现状 | gate |
|---|---|---|---|
| `POST /api/teams/[teamId]/invitations` | `src/app/api/teams/[teamId]/invitations/route.ts:14` | 顶层 `import { sendTeamInvitationEmail } from '@/lib/email/...'` + 第 212 行调 Resend 发邮件 | 软 gate by `CAN_RESEND`，或抽象 email provider（PR-4 决定） |
| `POST /api/teams/invitations/accept` | `src/app/api/teams/invitations/accept/route.ts:5` | **顶层 `import '@/lib/stripe'`** + 第 87/129 行调 `syncStripeSeats()` | **必须 hot-gate by direct macro** — 否则 Stripe SDK 泄入 on-prem bundle |

**修复策略**（PR-4）：
- 把 `syncStripeSeats()` 抽到独立模块，invitation accept 路由用直接 macro 守门：
  ```ts
  if (__DEPLOYMENT_MODE__ === 'saas') {
    const { syncStripeSeats } = await import('@/lib/stripe-seats');
    await syncStripeSeats(...);
  }
  ```
- Team email 发送：on-prem 行为待定 — 选项 A：复制邀请链接给 admin 手动发；选项 B：保留 Resend 软 gate；选项 C：抽 email provider 抽象（推荐 PR 单独处理）

---

## 6.6 Signup 风险链路（codex C3 补漏）

SaaS 反多重注册 / 防滥用机制 — on-prem 不需要，但当前嵌在 `src/db/adapter.ts` 里：

| 文件 | 用途 | on-prem 行为 |
|---|---|---|
| `src/db/adapter.ts:34` 引 `signup-rate-limit` | NextAuth adapter 包装 createUser，注入 risk-tier 评分 | on-prem：评分 + 限流可保留（防内部滥用），但 Slack 报警链路砍掉 |
| `src/db/adapter.ts:65` dynamic import `risk-tier` | 异步加 risk-tier 字段 | 同上 |
| `src/lib/signup-rate-limit.ts` | IP-based signup 限流 | on-prem：意义不大（只有 admin 邀请的用户进入），可保留但不暴露 |
| `src/lib/email-disposable.ts` | 一次性邮箱黑名单 | on-prem：完全无意义（用户由管理员邀请），可禁用 |
| `src/lib/auth-denial.ts` | 拒绝注册的统一返回 | 两种模式都用（admin 邀请失败也走这里） |
| `SLACK_RISK_WEBHOOK` env | 高 risk-tier 注册告警推 Slack | SaaS only；on-prem 客户用自己的告警系统 |

**修复策略**（PR-4）：
- `src/db/adapter.ts` 中的 risk-tier 评分注入：保留逻辑但用 `if (!CAN_RISKTIER) skip` 短路
- `signup-rate-limit` + `email-disposable`：保留代码，但因 on-prem `/signup` 路由本身 404，调用链触发不到（dead-code 但不影响）
- `SLACK_RISK_WEBHOOK`：on-prem 不报错缺失（env-validation 加 `requiredIn: ['saas']`）

---

## 7. Libraries — Heavy（拉 SaaS SDK）

| 文件 | 拉入的包 | 当前消费者数 | 处理策略 |
|---|---|---|---|
| `src/lib/stripe.ts` | `stripe` | 7+ 处 | 改成 `if (!IS_SAAS) throw` + 动态 import；on-prem `webpack.resolve.alias.stripe = false` 硬阻断 |
| `src/lib/mixpanel.ts` | `mixpanel-browser` | 客户端组件多处 | `if (!CAN_MIXPANEL) return noop` |
| `src/lib/resend.ts` | `resend` | trial-ending + auth flows | `if (!CAN_RESEND) return noop` + alias |
| `src/lib/email/trial-ending.ts` | 间接 resend | trial cron | gate by `CAN_RESEND` |
| `src/lib/dunning.ts` | 间接 resend + stripe | dunning cron | gate by `CAN_DUNNING` |
| `src/lib/stripe-reconcile.ts` | stripe | reconcile cron | gate by `CAN_BILLING` |
| `src/lib/snapshot-pusher.ts` | 间接 stripe（plan snapshot 推送给 aster-api） | internal snapshot route | gate by `CAN_BILLING`（plan snapshot 仅 SaaS 需要） |

---

## 8. Libraries — Light（无外部 SDK，跨模式共用）

| 文件 | 说明 | 处理策略 |
|---|---|---|
| `src/lib/plans.ts` | 货币/价格常量、plan 类型 | **保留**，类型在两种模式共用；on-prem 用 `LegacyPlanLimits` 即可 |
| `src/lib/risk-tier.ts` | risk-tier 评分逻辑 | **保留**，类型导出共用；调用点用 `if (!CAN_RISKTIER) skip` |
| `src/lib/plan-gate-client.ts` | aster-api 调用的 plan gate 客户端 | **保留**，两种模式都需要把 plan 推给 aster-api（on-prem 推固定 enterprise） |

---

## 8.5 UI affordances — SaaS-only 链接 / 文案 / banner（codex M2 补漏）

PR-5 不止改导航 — 这些散落组件也需按模式条件渲染：

| 组件 | 文件 | SaaS 行为 | on-prem 行为 |
|---|---|---|---|
| Dunning banner | `src/components/dashboard/dunning-banner.tsx:29` | 显示 "您的订阅支付失败" + 链接到 `/billing` | 隐藏（`if (!CAN_DUNNING) return null`） |
| Upgrade blocker | `src/components/billing/upgrade-blocker.tsx:75` | "您已达 Free 限额，升级 Pro" + 链接 `/pricing` | 隐藏（升级概念不存在；on-prem 用户已是 enterprise plan） |
| Dashboard cards | `src/app/[locale]/(dashboard)/dashboard/dashboard-content.tsx` | "您的订阅" / "本月用量 / Pro" | 改 "License status" / "Used by your org" |
| Command palette | `src/components/dashboard/command-palette.tsx` | 含 "升级到 Pro" / "管理订阅" 快捷项 | 过滤掉 SaaS-only 命令 |
| Policy form | `src/components/policy/ai-assistant-panel.tsx` | quota 提示链接到 `/billing` | 改 "Contact admin for quota" |
| Trash page | `src/app/[locale]/(dashboard)/policies/trash/` | 显示 "Pro 用户保留 30 天" | 改 "Retention: 30 days" 无升级 CTA |
| Marketing footer | `src/components/marketing/*` | "Sign up free" / "Pricing" | 移除 |

**修复策略**：每个组件 import `CLIENT_CAPABILITIES`（来自 `@/hooks/use-deployment-mode`），条件渲染。这些**不需要 DCE**（UI 文案小、运行期决定 OK），属于纯运行期 gate。

---

## 9. Auth surfaces

| 文件 | SaaS 行为 | On-prem 行为 | gate |
|---|---|---|---|
| `src/app/api/auth/forgot-password/route.ts` | 发 Resend 邮件 | 应改用本地 SMTP 或返回"联系管理员"（PR 单独处理） | 软 gate by `CAN_RESEND` |
| `src/app/api/auth/reset-password/route.ts` | 验链接 + 设密码 | 两种都需要 | 不 gate |
| `src/app/api/auth/verify-login` | Turnstile / 速率限制 / 账户锁 | 两种都需要 | 不 gate |
| `src/auth.ts` Credentials provider | 引用 `@/lib/plans` 设默认 plan | on-prem 应跳过 plan 自动 trial 逻辑 | 局部 `if (IS_SAAS) startTrial(...)` |
| `/signup`（如存在） | 自助注册 | 404 或 "Contact admin" | `CAN_SIGNUP` |

---

## 10. npm 依赖（SaaS-only）

```jsonc
// package.json — 这三个在 on-prem 模式下必须从 bundle 中消失
{
  "dependencies": {
    "stripe": "^20.1.0",
    "mixpanel-browser": "^2.73.0",
    "resend": "^6.8.0"
  }
}
```

**On-prem 构建守门**（在 `next.config.ts`）：

```ts
if (mode === 'on-prem') {
  config.resolve.alias = {
    ...config.resolve.alias,
    stripe: false,
    'mixpanel-browser': false,
    resend: false,
  };
}
```

**CI 守门**：`pnpm verify:on-prem-bundle` 扫 `.open-next/server-functions/**/*.js` + `.open-next/worker.js` 不能含 `StripeAPIError` / `StripeResource` / `from "stripe"` / `from "resend"` / `from "mixpanel-browser"`。`pnpm why stripe` 仅用于依赖可视性（package.json 里 stripe 仍然存在 — SaaS build 用），不是 on-prem 成功标准。

---

## 11. Env vars

### SaaS-only（`requiredIn: ['saas']`）

| 变量 | 类别 | 来源 |
|---|---|---|
| `STRIPE_SECRET_KEY` | Stripe | secret |
| `STRIPE_WEBHOOK_SECRET` | Stripe | secret |
| `NEXT_PUBLIC_STRIPE_PRO_MONTHLY_PRICE_ID` | Stripe | public env |
| `NEXT_PUBLIC_STRIPE_PRO_YEARLY_PRICE_ID` | Stripe | public env |
| `NEXT_PUBLIC_STRIPE_PRO_MONTHLY_CNY_PRICE_ID` | Stripe | public env |
| `NEXT_PUBLIC_STRIPE_PRO_YEARLY_CNY_PRICE_ID` | Stripe | public env |
| （EUR price IDs 当前未在 env-validation 必填，但 plans.ts 有 EUR 定价 — TODO 补全） | Stripe | public env |
| `NEXT_PUBLIC_MIXPANEL_TOKEN` | Mixpanel | public env |
| `RESEND_API_KEY` | Resend | secret |
| `ASTER_PLAN_GATE_HMAC_KEY` | 跨服务 PlanGate | secret —— SaaS 主要场景，但 on-prem 如果也推 plan snapshot 给 aster-api 仍需要 |
| `NEXT_PUBLIC_APP_URL` | 部署 URL | 两种模式都要 |

### On-prem 专属（`requiredIn: ['on-prem']`）— PR-2 添加

| 变量 | 用途 |
|---|---|
| `LICENSE_KEY` | Aster Enterprise license key（PR-8 占位页消费） |
| `SSO_PROVIDER` | SAML / OIDC provider id（PR-8 占位） |

### 两种模式都要

`DATABASE_URL`、`AUTH_SECRET`、`CRON_SECRET`、`GITHUB_CLIENT_ID/SECRET`、`GOOGLE_CLIENT_ID/SECRET`、`ADMIN_EMAIL`、`ADMIN_INITIAL_PASSWORD`、`DEBUG_SECRET`（临时）

---

## 12. DB schema — 按归属分类（codex M3 重排）

**总策略**：schema 列保留（避免 on-prem 与 SaaS 数据库 diff），但按归属类别明确哪些代码路径在 on-prem 不读不写。

### 12.1 Billing（Stripe — on-prem 不读不写）

```ts
stripeCustomerId, subscriptionId, subscriptionStatus, priceLockedAt, legacyTier
trialStartedAt, trialEndsAt, trialEndingEmailSentAt
gracePeriodStartsAt, gracePeriodEndsAt
dunningEmailsSentCount, lastDunningEmailSentAt, downgradedAt
```

### 12.2 Signup risk（反多重注册 — on-prem 不读不写）

```ts
signupIpHash               // SHA256(ip+salt) 前 16 字符，反多重注册聚类
riskTier                   // 0..4 风险等级
riskTierReason             // 评分理由（审计）
```

### 12.3 Quota email 提醒（SaaS 计费派生 — on-prem 不读不写）

```ts
apiQuotaWarn80SentAt       // 80% 配额 email 幂等标记
apiQuotaWarn100SentAt      // 100%
apiQuotaWarn200SentAt      // 200%
```

> on-prem 客户配额由 admin 控制台监控，不发邮件提醒；这些字段写入路径完全在 cron job 里（已经在 §4 SaaS-only cron 列表中守门）。

### 12.4 AI 滥用 — **两种模式共享**

```ts
aiBannedUntil              // AI 防刷自动封禁
aiBanReason                // 封禁原因
```

> 这些是产品行为（不是计费），on-prem 客户也需要 — 比如检测员工误用 AI 大量调用。**不 gate**。

### 12.5 Lifecycle — **两种模式共享**

```ts
emailVerified, deletedAt, purgePendingUntil  // GDPR 30d 软删 → 硬删
reactivationCount, priorPurgeCount           // 复活滥用追踪
onboardingUseCase, onboardingGoals, onboardingCompletedAt
mustChangePassword                            // 强制首登改密
isAdmin                                       // admin gate
failedLoginAttempts, lastFailedLoginAt, lockedUntil, lockoutCount  // 账户锁
```

### 12.6 总结

- **on-prem 不读不写**：§12.1 + §12.2 + §12.3 → 共 **14 列**（10 billing + 3 risk + 3 quota-email）
- **两种共享**：§12.4 + §12.5 → 不需要任何 gate
- **未来**：如 on-prem 客户对 schema 干净度有强诉求，可走 migration 后置删除列；本计划**不动 schema**

---

## 13. Seed scripts

| 文件 | SaaS 用途 | On-prem 处理 |
|---|---|---|
| `src/scripts/seed-admin.ts` | 创建初始 admin 用户 | **两种模式都用** —— 不修改 |
| `src/scripts/seed-usability-tenant.ts` | 创建可用性测试租户 | SaaS-only —— 加 `if (!IS_SAAS) exit` |

---

## 14. Wrangler scheduled triggers

```toml
# wrangler.toml — 当前 SaaS 配置
[triggers]
crons = ["30 4 * * *", "0 5 * * *"]
#       └────┬─────┘  └───┬───┘
#       user-purge      risk-tier-decay
```

**On-prem `wrangler.toml`**（部署时由客户控制；本仓库可提供 `wrangler.on-prem.toml` 范例）：

```toml
[triggers]
# user-purge 仍需（GDPR）
# risk-tier-decay 移除（SaaS-only）
crons = ["30 4 * * *"]
```

**未来**（PR 范围外）：可考虑 `wrangler.toml` 模板化 + build-time 注入 cron 列表。

---

## 15. 客户端 telemetry / analytics

| 模块 | SaaS 行为 | On-prem 行为 |
|---|---|---|
| Mixpanel `initMixpanel()` / `track()` | 全量埋点 | 全部 no-op（CAN_MIXPANEL = false） |
| Sentry / Datadog（如有） | — | 客户自己接 |
| Server-side analytics | aggregate 推 Mixpanel | no-op |

---

## 16. Marketing 表面

| 路径 | SaaS | On-prem |
|---|---|---|
| `/` hero | `<SaasMarketingHero>`：CTA = "Start free trial" + 价格预告 | `<OnPremMarketingHero>`：CTA = "Contact sales" + "Self-hosted" 卖点 |
| `/pricing` | 完整三档定价表 | 404 |
| `/signup` | 自助注册 | 404 |
| `/login` | GitHub + Google + email/password | 视客户配置：GitHub/Google 可保留，email/password 默认开；SAML（PR-8 之后）|

---

## 17. PR-4 检查清单（直接对应本 inventory）

合并 PR-4 前，**逐行勾选**：

```
Pages:
  [ ] src/app/[locale]/pricing/page.tsx                          gate by CAN_PRICING
  [ ] src/app/[locale]/(dashboard)/billing/page.tsx              gate by CAN_BILLING
  [ ] src/app/[locale]/(auth)/signup/page.tsx (if exists)        gate by CAN_SIGNUP
  [ ] src/app/[locale]/(dashboard)/admin/risk-tier/page.tsx      gate by CAN_RISKTIER

APIs (Stripe):
  [ ] src/app/api/stripe/webhook/route.ts                        gate by CAN_BILLING
  [ ] src/app/api/stripe/portal/route.ts                         gate by CAN_BILLING
  [ ] src/app/api/stripe/checkout/route.ts                       gate by CAN_BILLING

APIs (Admin):
  [ ] src/app/api/admin/risk-tier/route.ts                       gate by CAN_RISKTIER

APIs (User):
  [ ] src/app/api/user/dunning-status/route.ts                   gate by CAN_DUNNING

APIs (Cron — SaaS-only):
  [ ] src/app/api/cron/risk-tier-decay/route.ts                  gate by CAN_RISKTIER
  [ ] src/app/api/cron/dunning-emails/route.ts                   gate by CAN_DUNNING
  [ ] src/app/api/cron/trial-day-1-reminder/route.ts             gate by CAN_BILLING
  [ ] src/app/api/cron/auto-downgrade/route.ts                   gate by CAN_BILLING
  [ ] src/app/api/cron/reconcile-stripe-seats/route.ts           gate by CAN_BILLING
  [ ] src/app/api/cron/api-quota-alerts/route.ts                 gate by CAN_BILLING
  [ ] src/app/api/cron/byok-healthcheck/route.ts                 gate by CAN_BILLING

Libraries (lazy-load + gate):
  [ ] src/lib/stripe.ts                                          dynamic import + IS_SAAS guard
  [ ] src/lib/mixpanel.ts                                        CAN_MIXPANEL noop branch
  [ ] src/lib/resend.ts                                          CAN_RESEND noop branch
  [ ] src/lib/email/trial-ending.ts                              CAN_RESEND gate
  [ ] src/lib/dunning.ts                                         CAN_DUNNING gate
  [ ] src/lib/stripe-reconcile.ts                                CAN_BILLING gate
  [ ] src/lib/snapshot-pusher.ts                                 CAN_BILLING gate

Auth:
  [ ] src/auth.ts startTrial logic                               IS_SAAS conditional
  [ ] src/app/api/auth/forgot-password/route.ts                  CAN_RESEND soft-gate

next.config.ts:
  [ ] DefinePlugin __DEPLOYMENT_MODE__
  [ ] On-prem resolve.alias: stripe/mixpanel-browser/resend = false

UI nav:
  [ ] src/components/dashboard/sidebar.tsx                       CLIENT_CAPABILITIES filter
  [ ] src/components/admin/admin-sidebar.tsx (new)               CAN_* constants
  [ ] Marketing hero variants                                    IS_SAAS branch

Seed:
  [ ] src/scripts/seed-usability-tenant.ts                       IS_SAAS guard exit

Team invitations (codex C2):
  [ ] src/app/api/teams/invitations/accept/route.ts              HOT-GATE: extract syncStripeSeats to dynamic import behind direct __DEPLOYMENT_MODE__ macro
  [ ] src/app/api/teams/[teamId]/invitations/route.ts            CAN_RESEND soft-gate (or abstract email provider)

Signup risk chain (codex C3):
  [ ] src/db/adapter.ts                                          if (!CAN_RISKTIER) skip risk-tier injection; if (!IS_SAAS) skip SLACK_RISK_WEBHOOK
  [ ] src/lib/signup-rate-limit.ts                               keep code (dead in on-prem because /signup is 404)
  [ ] src/lib/email-disposable.ts                                keep code (dead in on-prem)

UI affordances (codex M2 — runtime gate only, no DCE needed):
  [ ] src/components/dashboard/dunning-banner.tsx                CAN_DUNNING conditional render
  [ ] src/components/billing/upgrade-blocker.tsx                 CAN_BILLING conditional render
  [ ] src/app/[locale]/(dashboard)/dashboard/dashboard-content.tsx  capability-driven card variants
  [ ] src/components/dashboard/command-palette.tsx               filter SaaS-only commands
  [ ] src/components/policy/ai-assistant-panel.tsx               quota CTA per mode
  [ ] src/app/[locale]/(dashboard)/policies/trash/page.tsx       remove upgrade CTA on on-prem
  [ ] src/components/marketing/*                                 footer variants
```

---

## 18. 已知缺口 / 待澄清

1. ~~`/signup` 路径未确认~~ ✅ 已确认存在于 `src/app/[locale]/(auth)/signup/page.tsx`
2. **EUR Stripe price IDs**：`src/lib/plans.ts` 定义了 EUR 价格但 `env-validation.ts` 没必填 `NEXT_PUBLIC_STRIPE_PRO_*_EUR_PRICE_ID`；PR-2 顺手补全
3. **On-prem 的 plan snapshot**：on-prem 客户也需要把 plan 推给 aster-api（enterprise 固定值）— `snapshot-pusher.ts` 不一定能完全 gate 掉，需更细的 `pushSaasPlan()` vs `pushEnterprisePlan()` 分支
4. **Charge dispute webhook**：`charge-dispute-created.ts` 是 SaaS-only，但 webhook route 守门后子处理器不需要单独 gate
5. **Sentry / Datadog**：当前 codebase 未见，但 on-prem 客户可能自接 — 提前预留 telemetry abstraction（不在本计划范围）
6. **Email provider abstraction**：team invitation 邮件 + forgot-password 邮件目前直接调 Resend；on-prem 客户可能要接 SMTP 或邮件链接复制。需单独 PR 抽 `EmailProvider` 接口（不在 v2 PR-4 范围）
7. **OpenNext production edges**（codex M4）：spike 仅扫了 `.open-next/server-functions/`；PR-1b 的 verify 脚本必须覆盖：
   - `.open-next/worker.js`
   - `.open-next/server-functions/**`
   - `.open-next/middleware/**`
   - `.open-next/dynamodb-provider/**`
   - 根目录 `worker.js`（这个仓库的自定义 worker）
   - source maps / manifests（如果生成）
   - 任何 `runtime = 'edge'` 路由（当前 grep 未发现，但需未来守门）
