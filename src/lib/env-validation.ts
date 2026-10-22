// 启动期 env 校验（fail-fast）
//
// 设计意图：
//   - production 启动时缺关键 env → 立即 throw，避免上线后业务路径才发现
//   - development 仅 warn，让本地开发不被打断
//   - test 完全跳过（避免 contract test / unit test 自构造 env 误触发）
//
// 触发点：next.config.ts 顶层调用 validateEnvOrWarn()；src/instrumentation.ts
// 启动时调用 validateEnvOrThrow()（Cloudflare runtime 改用 warn — 见 instrumentation.ts
// 的 isCloudflareWorker 分支）。
//
// 模式感知（PR-2 新增）：每条 ENV_CHECKS 可带 `requiredIn: ['saas' | 'on-prem']`
// 限定哪种部署模式下必填。未指定 → 两种模式都必填。
//   - SaaS 模式（默认）：Stripe / Mixpanel / Resend 等 SaaS-only 必填；
//     LICENSE_KEY / SSO_PROVIDER 等 on-prem-only 不校验
//   - On-Prem 模式：反之
// 设计依据：.claude/plan/deployment-mode-flag-v2.md PR-2 + saas-only-inventory.md §11
//
// 详见：aster-deploy/docs/pm/05-pricing-packaging.md / 03-telemetry-spec.md

import {
  type DeploymentMode,
  getDeploymentMode,
} from './deployment-mode';
import { safeProcessEnv } from './runtime/safe-env';

/**
 * P0-R8/R9 (codex review): no-process safe env reader.
 * 之前 validateEnvOrWarn/Throw/checkEnv 默认参数 `env = process.env` 在
 * 调用点求值，无 process 全局的 edge runtime 会先抛 ReferenceError。
 * 改为内部惰性求值，typeof check + try/catch 隔离。
 *
 * R9：抽到 @/lib/runtime/safe-env 共享，避免每个文件复制一份 helper。
 */
const getProcessEnv = safeProcessEnv;

type EnvCheck = {
  /**
   * 环境变量名。可单一字符串，或多名别名（任一被设置即视为通过）。
   * 别名场景示例：Auth.js v5 标准名是 `AUTH_SECRET`，但仓库历史曾用 v4
   * 的 `NEXTAUTH_SECRET`（见 src/auth.ts:402 + wrangler.toml）。操作员
   * 配任一即可。错误信息列出别名组：`AUTH_SECRET | NEXTAUTH_SECRET`。
   */
  key: string | ReadonlyArray<string>;
  /** always = 两种 NODE_ENV 都必填；production-only = 仅生产校验，dev 仅 warn。 */
  required: 'always' | 'production-only';
  /**
   * 限定哪种部署模式才校验。省略 = 两种模式都校验。
   * 用于把 Stripe（saas only）与 LICENSE_KEY（on-prem only）等隔离。
   */
  requiredIn?: ReadonlyArray<DeploymentMode>;
  /** 给操作员看的简短描述，错误日志里会拼出来。 */
  description: string;
  /**
   * 为 true 时，只要运行时存在数据库 binding（Cloudflare Hyperdrive）即视为满足。
   * 生产 Worker 经 HYPERDRIVE binding 连库，从不设 DATABASE_URL（见 src/db/index.ts
   * getConnectionString 的优先级）；不认 binding 会在每次冷启动报一条假的「缺失」。
   */
  satisfiedByDbBinding?: boolean;
};

/** 校验时的运行时事实（env 字典表达不了的部分）。 */
export interface EnvCheckOptions {
  /** 运行时是否已有可用的数据库 binding（Hyperdrive）。 */
  hasDbBinding?: boolean;
}

/**
 * 关键 env 清单。
 *
 * 把"必须配的 env"放进代码，新增 SKU / feature / 部署模式资产时
 * 强制更新此清单（contract）。每行注释说明归属与启用模式。
 */
const ENV_CHECKS: readonly EnvCheck[] = [
  // ── 共享（两种模式都要）─────────────────────────────────────────
  {
    key: 'DATABASE_URL',
    required: 'always',
    description: 'Drizzle / Postgres 连接串（Cloudflare 上由 HYPERDRIVE binding 提供时可不设）',
    satisfiedByDbBinding: true,
  },
  {
    // Auth.js v5 标准名 AUTH_SECRET；wrangler.toml + 既有 Worker secrets
    // 用 v4 历史名 NEXTAUTH_SECRET。src/auth.ts 两个都接受 — 这里也接受。
    key: ['AUTH_SECRET', 'NEXTAUTH_SECRET'],
    required: 'production-only',
    description: 'NextAuth 加密密钥（AUTH_SECRET 或 NEXTAUTH_SECRET 任一即可）',
  },
  {
    key: 'CRON_SECRET',
    required: 'production-only',
    description:
      'Cloudflare/Vercel cron trigger 鉴权密钥；缺失时所有 cron route 返回 503',
  },
  {
    key: 'NEXT_PUBLIC_APP_URL',
    required: 'production-only',
    description:
      '部署 URL（webhook redirect / 邮件 CTA）。**同时是 CSRF 网关（审计 #168）的默认允许 Origin**——'
      + 'production 缺失则所有非 Bearer 的 cookie-auth 变更 API 会被 checkCsrf fail-closed 拒（403）。'
      + '多域名/preview/custom domain 部署须另配 CSRF_ALLOWED_ORIGINS（逗号分隔）。',
  },
  {
    key: 'ASTER_PLAN_GATE_HMAC_KEY',
    required: 'production-only',
    description:
      'PlanGate HMAC 共享密钥（两种模式都需要把 plan snapshot 推给 aster-api）',
  },

  // ── SaaS-only：Stripe Pro 三货币 × 月/年 = 6 个 priceId ─────────
  // 详见 aster-deploy/docs/pm/05-pricing-packaging.md F2 + plans.ts
  {
    key: 'STRIPE_SECRET_KEY',
    required: 'production-only',
    requiredIn: ['saas'],
    description: 'Stripe API 密钥',
  },
  {
    key: 'STRIPE_WEBHOOK_SECRET',
    required: 'production-only',
    requiredIn: ['saas'],
    description: 'Stripe webhook 验签',
  },
  {
    key: 'NEXT_PUBLIC_STRIPE_PRO_MONTHLY_PRICE_ID',
    required: 'production-only',
    requiredIn: ['saas'],
    description: 'Pro USD 月付 Stripe priceId',
  },
  {
    key: 'NEXT_PUBLIC_STRIPE_PRO_YEARLY_PRICE_ID',
    required: 'production-only',
    requiredIn: ['saas'],
    description: 'Pro USD 年付 Stripe priceId',
  },
  {
    key: 'NEXT_PUBLIC_STRIPE_PRO_MONTHLY_CNY_PRICE_ID',
    required: 'production-only',
    requiredIn: ['saas'],
    description: 'Pro CNY 月付 Stripe priceId',
  },
  {
    key: 'NEXT_PUBLIC_STRIPE_PRO_YEARLY_CNY_PRICE_ID',
    required: 'production-only',
    requiredIn: ['saas'],
    description: 'Pro CNY 年付 Stripe priceId',
  },
  // EUR — plans.ts:44-45 已经读这两个 key，但 v1 漏配必填校验（已知缺口 §18.2）
  {
    key: 'NEXT_PUBLIC_STRIPE_PRO_MONTHLY_EUR_PRICE_ID',
    required: 'production-only',
    requiredIn: ['saas'],
    description: 'Pro EUR 月付 Stripe priceId',
  },
  {
    key: 'NEXT_PUBLIC_STRIPE_PRO_YEARLY_EUR_PRICE_ID',
    required: 'production-only',
    requiredIn: ['saas'],
    description: 'Pro EUR 年付 Stripe priceId',
  },

  // ── SaaS-only：NSM 埋点 ────────────────────────────────────────
  {
    key: 'NEXT_PUBLIC_MIXPANEL_TOKEN',
    required: 'production-only',
    requiredIn: ['saas'],
    description: 'Mixpanel project token（NSM 漏斗埋点）',
  },

  // ── SaaS-only：邮件（trial reminder + 失败通知 + 团队邀请）─────
  {
    key: 'RESEND_API_KEY',
    required: 'production-only',
    requiredIn: ['saas'],
    description:
      'Resend 邮件服务（on-prem 客户自行接 SMTP / 复制邀请链接代替）',
  },

  // ── SaaS-only：AI 调用内容审计 ───────────────────────────────────
  // 加密落库 prompt/completion，并在 GDPR 第 15 条导出时解密（lib/ai-audit-vault.ts、
  // api/user/ai-data-export）。缺失时导出只能给出未加密字段，原文部分标为 unavailable。
  // on-prem 的 staging/Helm 外部密钥清单尚未包含此项，先只在 SaaS 强校验。
  {
    key: 'AI_AUDIT_ENCRYPTION_SECRET',
    required: 'production-only',
    requiredIn: ['saas'],
    description: 'AI 审计原文加密主密钥（≥16 字符，入库后不可轮换，否则旧记录无法解密）',
  },

  // ── On-Prem-only：License + SSO ─────────────────────────────────
  // 占位字段；PR-8 的 /admin/license 与 /admin/sso 页面会真正消费
  {
    key: 'LICENSE_KEY',
    required: 'production-only',
    requiredIn: ['on-prem'],
    description: 'Aster Enterprise license key（决定 seat 上限 / 到期日 / 功能档）',
  },
  {
    key: 'SSO_PROVIDER',
    required: 'production-only',
    requiredIn: ['on-prem'],
    description: 'SAML / OIDC provider id（none / saml / oidc）',
  },

  // ── 故意未校验（optional）────────────────────────────────────────
  // 下列 env 在 saas-only-inventory.md §11 列出但故意不放入强校验：
  //
  //   GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
  //   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
  //     —— OAuth providers 至少配一个即可（wrangler.toml 文档化）；
  //        强制必填会让只用 credentials provider 的部署也报错。
  //        缺失时 src/auth.ts 把 clientId=undefined 传给 NextAuth，
  //        provider 会自动 disable（行为是已知的，且 wrangler 文档
  //        指导操作员只配自己用的那一个）。
  //
  //   ADMIN_EMAIL / ADMIN_INITIAL_PASSWORD
  //     —— 用于初始 admin bootstrap；首次部署后操作员应改密 + 移除。
  //        src/lib/db-bootstrap.ts 显式 if-set 处理，缺失即跳过 seed。
  //        强校验会让"已经初始化过、移除 secret"的稳态部署报误差错误。
  //
  //   DEBUG_SECRET
  //     —— 仅 /api/debug/admin-status 等诊断端点用；缺失时端点返回 503，
  //        生产建议长期不配（详见 src/app/api/debug/admin-status/route.ts）。
  //
  //   SLACK_RISK_WEBHOOK
  //     —— SaaS-only 高风险注册告警；缺失即降级（不报警，但其它流程正常）。
  //        当前判定为 nice-to-have 而非 must-have；若运营需要可以提升为
  //        `requiredIn: ['saas']`。
  //
  //   AI_WORKSPACE_HANDOFF_PRIVATE_KEY / AI_WORKSPACE_HMAC_KEY
  //     —— ADR 0049 AI 工作台：交接令牌 Ed25519 私钥（base64 PKCS#8）与服务间 HMAC 密钥。
  //        仅在启用工作台（NEXT_PUBLIC_AI_WORKSPACE_URL 已配置）时才需要；缺失即该功能
  //        保持关闭，旧版 React 面板不受影响，因此不能放入强校验。
  //
  //   AI_WORKSPACE_GDPR_HMAC_KEY
  //     —— cloud → 工作台 GDPR 导出 / 抹除端点的签名密钥（F23，见 lib/ai-workspace-gdpr.ts），
  //        与工作台 AIW_GDPR_HMAC_KEY 同值、至少 32 字节、与 AI_WORKSPACE_HMAC_KEY 不同（过短或相同按未配置处理）。工作台地址未配置时
  //        不调用；地址已配置而缺此密钥时，导出 / 清除照常完成 cloud 部分并提示工作台部分失败，
  //        不影响启动，因此不放入强校验。
  //
  // 增加新 env 时若想强校验，往 ENV_CHECKS 加条目即可；若刻意保持 optional，
  // 务必在本节追加说明便于后续维护者审计。
] as const;

export interface ValidationResult {
  /** missing 为空即 ok。 */
  ok: boolean;
  /** 必填但缺失，必须 throw / 拦发布。 */
  missing: string[];
  /** dev 模式下 production-only 未配 — 仅 warn 提示。 */
  warnings: string[];
  /** 校验时使用的部署模式（错误信息里展示，避免歧义）。 */
  mode: DeploymentMode;
}

/**
 * 校验当前 env，返回结果（不抛）。
 *
 * @param env  要校验的 env 字典，默认 process.env
 * @param mode 校验适用的部署模式，默认从 deployment-mode 模块读取（即当前 build）
 *
 * `mode` 显式参数主要给测试用：单测里同进程跑两种模式不用动 macro。
 * 生产代码调 `checkEnv()` 不带参就好。
 */
export function checkEnv(
  env: NodeJS.ProcessEnv = getProcessEnv(),
  mode?: DeploymentMode,
  options: EnvCheckOptions = {},
): ValidationResult {
  // 惰性求值 mode：避免在调用 getDeploymentMode() 时触发其 fail-closed 检查
  // （比如当传入的 env 表示 build/test 但 process.env 仍是 production 时）。
  const resolvedMode: DeploymentMode = mode ?? getDeploymentMode();
  const isProduction = env.NODE_ENV === 'production';
  const missing: string[] = [];
  const warnings: string[] = [];

  for (const check of ENV_CHECKS) {
    // 模式过滤：requiredIn 限定的项目，不在当前模式则完全跳过（不 warn 不 missing）
    if (check.requiredIn && !check.requiredIn.includes(resolvedMode)) continue;
    if (check.satisfiedByDbBinding && options.hasDbBinding) continue;

    // 多别名：任一被设置即视为通过
    const keys = Array.isArray(check.key) ? check.key : [check.key];
    const isMissingValue = keys.every((k) => {
      const v = env[k];
      return !v || v.trim() === '';
    });
    if (!isMissingValue) continue;

    const friendlyMsg = `${keys.join(' | ')} (${check.description})`;
    if (check.required === 'always') {
      missing.push(friendlyMsg);
    } else if (check.required === 'production-only') {
      if (isProduction) {
        missing.push(friendlyMsg);
      } else {
        warnings.push(friendlyMsg);
      }
    }
  }

  return {
    ok: missing.length === 0,
    missing,
    warnings,
    mode: resolvedMode,
  };
}

/**
 * 启动期 fail-fast：production 缺 env 直接抛
 *
 * - production：missing 任何 always/production-only → throw
 * - development：missing always → throw；缺 production-only → warn
 * - test：完全跳过（避免污染单元测试的自构造 env）
 *
 * 错误信息包含当前部署模式，便于排查 "我设了 STRIPE_*，怎么还报缺 LICENSE_KEY" 类问题。
 */
export function validateEnvOrThrow(
  env: NodeJS.ProcessEnv = getProcessEnv(),
  mode?: DeploymentMode,
): void {
  // 先做跳过判断，再解析 mode —— 避免在 test/CI 环境里多调一次
  // getDeploymentMode()（其内部可能触发 production fail-closed 断言）。
  if (env.NODE_ENV === 'test' || env.VITEST === 'true') return;

  const result = checkEnv(env, mode);
  if (!result.ok) {
    const lines = [
      `[env-validation] 缺失关键环境变量（部署模式: ${result.mode}）：`,
    ];
    for (const m of result.missing) lines.push(`  - ${m}`);
    lines.push('');
    lines.push('详见 src/lib/env-validation.ts 中的 ENV_CHECKS 清单');
    throw new Error(lines.join('\n'));
  }
  if (result.warnings.length > 0 && env.NODE_ENV !== 'production') {
    console.warn(
      `[env-validation] dev 模式下以下 env 未配（生产必须配齐，部署模式: ${result.mode}）：`,
    );
    for (const w of result.warnings) console.warn(`  - ${w}`);
  }
}

/**
 * 仅 warn 不 throw 版本，用于 next.config 等不能阻塞编译的场景。
 *
 * Cloudflare Workers runtime 也走这里 —— secret binding 不通过 process.env 暴露，
 * throw 会让每个冷启喷一长串 error 看上去像 outage。详见 instrumentation.ts。
 */
export function validateEnvOrWarn(
  env: NodeJS.ProcessEnv = getProcessEnv(),
  mode?: DeploymentMode,
  options: EnvCheckOptions = {},
): void {
  // 先做跳过判断，再解析 mode（同 validateEnvOrThrow 的原因）。
  if (env.NODE_ENV === 'test' || env.VITEST === 'true') return;
  if (env.NEXT_PHASE === 'phase-production-build') {
    // 构建阶段（next build）部分 runtime env 还未注入，跳过 production-only 校验
    return;
  }

  const result = checkEnv(env, mode, options);
  if (!result.ok) {
    console.error(
      `[env-validation] 缺失关键环境变量（runtime 启动将失败，部署模式: ${result.mode}）：`,
    );
    for (const m of result.missing) console.error(`  - ${m}`);
  }
  if (result.warnings.length > 0) {
    console.warn(
      `[env-validation] 以下 env 未配（生产必须配齐，部署模式: ${result.mode}）：`,
    );
    for (const w of result.warnings) console.warn(`  - ${w}`);
  }
}
