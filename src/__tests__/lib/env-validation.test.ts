import { describe, it, expect } from 'vitest';
import {
  checkEnv,
  validateEnvOrThrow,
  validateEnvOrWarn,
} from '@/lib/env-validation';

/**
 * env 校验测试
 *
 * 用 checkEnv(env, mode) 显式注入隔离的 ProcessEnv + deployment mode，
 * 避免污染当前进程，也不依赖测试运行时是 SaaS 还是 on-prem build。
 */

/** SaaS production 全配齐的 env。 */
function makeFullSaasProductionEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://x',
    AUTH_SECRET: 'secret',
    CRON_SECRET: 'cron-secret',
    NEXT_PUBLIC_APP_URL: 'https://aster-lang.cloud',
    ASTER_PLAN_GATE_HMAC_KEY: 'hmac-key',

    // SaaS-only
    STRIPE_SECRET_KEY: 'sk_test',
    STRIPE_WEBHOOK_SECRET: 'whsec',
    NEXT_PUBLIC_STRIPE_PRO_MONTHLY_PRICE_ID: 'price_pro_usd_m',
    NEXT_PUBLIC_STRIPE_PRO_YEARLY_PRICE_ID: 'price_pro_usd_y',
    NEXT_PUBLIC_STRIPE_PRO_MONTHLY_CNY_PRICE_ID: 'price_pro_cny_m',
    NEXT_PUBLIC_STRIPE_PRO_YEARLY_CNY_PRICE_ID: 'price_pro_cny_y',
    NEXT_PUBLIC_STRIPE_PRO_MONTHLY_EUR_PRICE_ID: 'price_pro_eur_m',
    NEXT_PUBLIC_STRIPE_PRO_YEARLY_EUR_PRICE_ID: 'price_pro_eur_y',
    NEXT_PUBLIC_MIXPANEL_TOKEN: 'mp-token',
    RESEND_API_KEY: 're_key',
  } as NodeJS.ProcessEnv;
}

/** On-prem production 全配齐的 env（无 SaaS-only secrets）。 */
function makeFullOnPremProductionEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://x',
    AUTH_SECRET: 'secret',
    CRON_SECRET: 'cron-secret',
    NEXT_PUBLIC_APP_URL: 'https://aster.acme-corp.internal',
    ASTER_PLAN_GATE_HMAC_KEY: 'hmac-key',

    // On-prem-only
    LICENSE_KEY: 'aster-ent-2026-abcdef',
    SSO_PROVIDER: 'saml',
  } as NodeJS.ProcessEnv;
}

describe('env-validation — SaaS mode', () => {
  it('production 全配齐 → ok', () => {
    const result = checkEnv(makeFullSaasProductionEnv(), 'saas');
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.mode).toBe('saas');
  });

  it('production 缺 DATABASE_URL → missing', () => {
    const env = makeFullSaasProductionEnv();
    delete env.DATABASE_URL;
    const result = checkEnv(env, 'saas');
    expect(result.ok).toBe(false);
    expect(result.missing.some((m) => m.startsWith('DATABASE_URL'))).toBe(true);
  });

  /* ★生产 Worker 经 HYPERDRIVE binding 连库、从不设 DATABASE_URL。
   *   不认 binding 会在每次冷启动刷一条假的「缺 DATABASE_URL」。 */
  it('★有 Hyperdrive binding 时缺 DATABASE_URL 不算缺失', () => {
    const env = makeFullSaasProductionEnv();
    delete env.DATABASE_URL;
    const result = checkEnv(env, 'saas', { hasDbBinding: true });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('★binding 只豁免 DATABASE_URL，不豁免其它缺失项', () => {
    const env = makeFullSaasProductionEnv();
    delete env.DATABASE_URL;
    delete env.CRON_SECRET;
    delete env.STRIPE_SECRET_KEY;
    const result = checkEnv(env, 'saas', { hasDbBinding: true });
    expect(result.missing.some((m) => m.startsWith('DATABASE_URL'))).toBe(false);
    expect(result.missing.some((m) => m.startsWith('CRON_SECRET'))).toBe(true);
    expect(result.missing.some((m) => m.startsWith('STRIPE_SECRET_KEY'))).toBe(true);
  });

  it('production 缺 Pro priceId 任一 → missing', () => {
    const env = makeFullSaasProductionEnv();
    delete env.NEXT_PUBLIC_STRIPE_PRO_MONTHLY_CNY_PRICE_ID;
    const result = checkEnv(env, 'saas');
    expect(result.ok).toBe(false);
    expect(
      result.missing.some((m) =>
        m.includes('NEXT_PUBLIC_STRIPE_PRO_MONTHLY_CNY_PRICE_ID'),
      ),
    ).toBe(true);
  });

  it('production 缺 EUR Pro priceId → missing（v1 漏配修复）', () => {
    const env = makeFullSaasProductionEnv();
    delete env.NEXT_PUBLIC_STRIPE_PRO_MONTHLY_EUR_PRICE_ID;
    const result = checkEnv(env, 'saas');
    expect(result.ok).toBe(false);
    expect(
      result.missing.some((m) =>
        m.includes('NEXT_PUBLIC_STRIPE_PRO_MONTHLY_EUR_PRICE_ID'),
      ),
    ).toBe(true);
  });

  it('production 缺 ASTER_PLAN_GATE_HMAC_KEY → missing', () => {
    const env = makeFullSaasProductionEnv();
    delete env.ASTER_PLAN_GATE_HMAC_KEY;
    const result = checkEnv(env, 'saas');
    expect(result.ok).toBe(false);
    expect(
      result.missing.some((m) => m.includes('ASTER_PLAN_GATE_HMAC_KEY')),
    ).toBe(true);
  });

  it('production 缺 Mixpanel token → missing', () => {
    const env = makeFullSaasProductionEnv();
    delete env.NEXT_PUBLIC_MIXPANEL_TOKEN;
    const result = checkEnv(env, 'saas');
    expect(result.ok).toBe(false);
  });

  it('SaaS 模式不校验 LICENSE_KEY / SSO_PROVIDER', () => {
    // 即使不配 on-prem 字段，SaaS 模式也应 ok
    const result = checkEnv(makeFullSaasProductionEnv(), 'saas');
    expect(result.ok).toBe(true);
    // 既不在 missing 也不在 warnings
    expect(
      result.missing.some((m) => m.includes('LICENSE_KEY')),
    ).toBe(false);
    expect(
      result.warnings.some((w) => w.includes('LICENSE_KEY')),
    ).toBe(false);
  });
});

describe('env-validation — On-Prem mode', () => {
  it('production 全配齐 → ok（无 Stripe / Mixpanel / Resend）', () => {
    const result = checkEnv(makeFullOnPremProductionEnv(), 'on-prem');
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.mode).toBe('on-prem');
  });

  it('on-prem 缺 LICENSE_KEY → missing', () => {
    const env = makeFullOnPremProductionEnv();
    delete env.LICENSE_KEY;
    const result = checkEnv(env, 'on-prem');
    expect(result.ok).toBe(false);
    expect(result.missing.some((m) => m.startsWith('LICENSE_KEY'))).toBe(true);
  });

  it('on-prem 缺 SSO_PROVIDER → missing', () => {
    const env = makeFullOnPremProductionEnv();
    delete env.SSO_PROVIDER;
    const result = checkEnv(env, 'on-prem');
    expect(result.ok).toBe(false);
    expect(result.missing.some((m) => m.startsWith('SSO_PROVIDER'))).toBe(true);
  });

  it('on-prem 不校验 STRIPE_SECRET_KEY / NEXT_PUBLIC_STRIPE_* / MIXPANEL / RESEND', () => {
    // 完全不配 SaaS 字段，仍然 ok
    const result = checkEnv(makeFullOnPremProductionEnv(), 'on-prem');
    expect(result.ok).toBe(true);
    // 关键 saas-only 字段不应出现在 missing/warnings
    const saasKeys = [
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'NEXT_PUBLIC_STRIPE_PRO_MONTHLY_PRICE_ID',
      'NEXT_PUBLIC_STRIPE_PRO_YEARLY_PRICE_ID',
      'NEXT_PUBLIC_STRIPE_PRO_MONTHLY_CNY_PRICE_ID',
      'NEXT_PUBLIC_STRIPE_PRO_YEARLY_CNY_PRICE_ID',
      'NEXT_PUBLIC_STRIPE_PRO_MONTHLY_EUR_PRICE_ID',
      'NEXT_PUBLIC_STRIPE_PRO_YEARLY_EUR_PRICE_ID',
      'NEXT_PUBLIC_MIXPANEL_TOKEN',
      'RESEND_API_KEY',
    ];
    for (const key of saasKeys) {
      expect(
        result.missing.some((m) => m.includes(key)),
        `${key} should NOT be missing in on-prem mode`,
      ).toBe(false);
      expect(
        result.warnings.some((w) => w.includes(key)),
        `${key} should NOT warn in on-prem mode`,
      ).toBe(false);
    }
  });

  it('on-prem 仍校验 DATABASE_URL（always-required）', () => {
    const env = makeFullOnPremProductionEnv();
    delete env.DATABASE_URL;
    const result = checkEnv(env, 'on-prem');
    expect(result.ok).toBe(false);
    expect(result.missing.some((m) => m.startsWith('DATABASE_URL'))).toBe(true);
  });

  it('on-prem 仍校验 ASTER_PLAN_GATE_HMAC_KEY（两种模式共享 — 推 plan snapshot 给 aster-api）', () => {
    const env = makeFullOnPremProductionEnv();
    delete env.ASTER_PLAN_GATE_HMAC_KEY;
    const result = checkEnv(env, 'on-prem');
    expect(result.ok).toBe(false);
    expect(
      result.missing.some((m) => m.startsWith('ASTER_PLAN_GATE_HMAC_KEY')),
    ).toBe(true);
  });
});

describe('env-validation — 通用行为', () => {
  it('development 仅缺 production-only env → ok=true，warnings 非空', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://x',
    } as NodeJS.ProcessEnv;
    const result = checkEnv(env, 'saas');
    expect(result.ok).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.missing).toEqual([]);
  });

  it('development 缺 always-required → missing', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'development',
    } as NodeJS.ProcessEnv;
    const result = checkEnv(env, 'saas');
    expect(result.ok).toBe(false);
    expect(result.missing.some((m) => m.startsWith('DATABASE_URL'))).toBe(true);
  });

  it('test 模式跳过', () => {
    expect(() =>
      validateEnvOrThrow({ NODE_ENV: 'test' } as NodeJS.ProcessEnv, 'saas'),
    ).not.toThrow();
  });

  it('VITEST=true 跳过', () => {
    expect(() =>
      validateEnvOrThrow(
        {
          NODE_ENV: 'production',
          VITEST: 'true',
        } as NodeJS.ProcessEnv,
        'saas',
      ),
    ).not.toThrow();
  });

  it('production 缺 env → validateEnvOrThrow 抛 Error 含 key 名 + mode', () => {
    let thrown: Error | undefined;
    try {
      validateEnvOrThrow(
        { NODE_ENV: 'production' } as NodeJS.ProcessEnv,
        'saas',
      );
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toMatch(/DATABASE_URL/);
    // 错误信息必须暴露当前部署模式，避免操作员看错清单
    expect(thrown!.message).toMatch(/saas/);
  });

  it('on-prem 缺 env → throw 信息包含 "on-prem" 上下文', () => {
    let thrown: Error | undefined;
    try {
      validateEnvOrThrow(
        { NODE_ENV: 'production' } as NodeJS.ProcessEnv,
        'on-prem',
      );
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toMatch(/on-prem/);
    expect(thrown!.message).toMatch(/LICENSE_KEY/);
    // 关键反向断言：on-prem 错误信息**不应**列出 SaaS-only 字段
    expect(thrown!.message).not.toMatch(/STRIPE_SECRET_KEY/);
    expect(thrown!.message).not.toMatch(/MIXPANEL/);
  });

  it('result.mode 字段如实反映传入的 mode', () => {
    expect(checkEnv({} as NodeJS.ProcessEnv, 'saas').mode).toBe('saas');
    expect(checkEnv({} as NodeJS.ProcessEnv, 'on-prem').mode).toBe('on-prem');
  });
});

describe('env-validation — AUTH_SECRET / NEXTAUTH_SECRET 别名', () => {
  it('AUTH_SECRET 单独设置 → ok', () => {
    const env = makeFullSaasProductionEnv();
    expect(env.AUTH_SECRET).toBeDefined();
    delete env.NEXTAUTH_SECRET;
    const result = checkEnv(env, 'saas');
    expect(result.ok).toBe(true);
  });

  it('NEXTAUTH_SECRET 单独设置 → ok（legacy v4 名）', () => {
    const env = makeFullSaasProductionEnv();
    delete env.AUTH_SECRET;
    env.NEXTAUTH_SECRET = 'legacy-secret';
    const result = checkEnv(env, 'saas');
    expect(result.ok).toBe(true);
    // 也不应在 warnings 里
    expect(
      result.warnings.some((w) => w.includes('AUTH_SECRET')),
    ).toBe(false);
  });

  it('AUTH_SECRET + NEXTAUTH_SECRET 两个都不设置 → missing', () => {
    const env = makeFullSaasProductionEnv();
    delete env.AUTH_SECRET;
    delete env.NEXTAUTH_SECRET;
    const result = checkEnv(env, 'saas');
    expect(result.ok).toBe(false);
    // missing 信息应列出两个名字，提示操作员任一即可
    expect(
      result.missing.some(
        (m) => m.includes('AUTH_SECRET') && m.includes('NEXTAUTH_SECRET'),
      ),
    ).toBe(true);
  });

  it('两个都设置 → ok（不重复报错）', () => {
    const env = makeFullSaasProductionEnv();
    env.NEXTAUTH_SECRET = 'also-set';
    const result = checkEnv(env, 'saas');
    expect(result.ok).toBe(true);
  });
});

describe('env-validation — mode 默认参数惰性求值', () => {
  it('test/VITEST 跳过路径不调 getDeploymentMode（不传 mode 也不爆）', () => {
    // 不传 mode；env 显式声明 test 模式 → 应直接 return，不应触发
    // getDeploymentMode 的任何副作用（哪怕 process.env 状态怪）。
    expect(() =>
      validateEnvOrThrow({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    ).not.toThrow();
    expect(() =>
      validateEnvOrThrow({
        NODE_ENV: 'production',
        VITEST: 'true',
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it('build phase 跳过路径不调 getDeploymentMode（next.config.ts 加载时安全）', () => {
    // next.config.ts 调 validateEnvOrWarn 时 NEXT_PHASE 已设；
    // 此时不该走 mode 解析，否则 production fail-closed 会误伤构建。
    expect(() =>
      validateEnvOrWarn({
        NODE_ENV: 'production',
        NEXT_PHASE: 'phase-production-build',
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});

/**
 * P0-R8/R9 regression: 无 process 全局的 runtime（Cloudflare Workers / browser）下
 * 默认参数不能在调用前 ReferenceError。
 *
 * R9 codex review 指出：早先版本用 `Object.defineProperty(globalThis, 'process',
 * { value: undefined })` 模拟，会让 `typeof process === 'undefined'` 为 true
 * 但 `process` 标识符 binding 仍存在，旧代码裸读 `process.env.X` 抛的是
 * **TypeError**（读 undefined.env），不是 edge runtime 真实抛的
 * **ReferenceError**（标识符未声明）。
 *
 * 修复：用 `delete (globalThis as any).process` 真正移除 binding，使
 * `process.env.X` 抛 `ReferenceError: process is not defined`，精确模拟
 * Cloudflare Workers / strict browser sandbox 行为。
 */
describe('env-validation — no-process runtime safety (P0-R8/R9)', () => {
  it('checkEnv() 不传 env、process binding 不存在 → 视为空 env，不抛 ReferenceError', () => {
    const g = globalThis as Record<string, unknown>;
    const hadProcess = 'process' in g;
    const origProcess = g.process;
    try {
      // delete 真正移除 binding，使裸 `process` 标识符抛 ReferenceError
      delete g.process;
      // sanity check: 确认 binding 真的被删了（typeof 安全检测）
      expect(typeof (g as Record<string, unknown>).process).toBe('undefined');

      const result = checkEnv(); // 默认参数走 safeProcessEnv()
      expect(result.ok).toBe(false);
      expect(result.missing.length).toBeGreaterThan(0);
    } finally {
      if (hadProcess) {
        g.process = origProcess;
      }
    }
  });

  it('validateEnvOrWarn() 不传 env、process binding 不存在 → 不抛（仅 console.error）', () => {
    const g = globalThis as Record<string, unknown>;
    const hadProcess = 'process' in g;
    const origProcess = g.process;
    const origConsoleError = console.error;
    const origConsoleWarn = console.warn;
    try {
      delete g.process;
      console.error = () => {};
      console.warn = () => {};
      expect(() => validateEnvOrWarn()).not.toThrow();
    } finally {
      if (hadProcess) {
        g.process = origProcess;
      }
      console.error = origConsoleError;
      console.warn = origConsoleWarn;
    }
  });

  it('真实 ReferenceError 行为：delete globalThis.process 后裸读 process.env 抛 ReferenceError（验证模拟手法）', () => {
    const g = globalThis as Record<string, unknown>;
    const hadProcess = 'process' in g;
    const origProcess = g.process;
    try {
      delete g.process;
      // 旧 bug 等价：裸标识符引用应抛 ReferenceError
      // 使用 eval 防止 TS 编译时改写 process 引用语义
      expect(() => {
        return (0, eval)('process.env.X');
      }).toThrow(ReferenceError);
    } finally {
      if (hadProcess) {
        g.process = origProcess;
      }
    }
  });
});
