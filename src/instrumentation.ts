// Next.js Instrumentation hook — 服务器启动时执行一次
// 详见 https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
//
// 用途：production 启动时校验关键 env，缺失立即 throw 让 K8s readiness probe 失败，
// 避免缺 env 的实例进流量池。

import { validateEnvOrThrow, validateEnvOrWarn } from './lib/env-validation';

/**
 * No-process safe env reader.
 *
 * P0-R7 (codex round 7 review): instrumentation.ts 之前只 guard 了第一处
 * process.env 访问，第 28 和 41 行仍裸读，会在无 process 全局的 edge
 * runtime 抛 ReferenceError。集中所有 env 读取经过本 helper，typeof check
 * 后才读。
 */
function safeEnv(key: string): string | undefined {
  try {
    if (typeof process !== 'undefined') {
      return process.env?.[key];
    }
  } catch {
    // process 不可访问
  }
  return undefined;
}

export async function register() {
  // P0-R5/R6 (codex review): 在 Workers / Node runtime 设置全局 production
  // 标志。aster-lang-ts isProductionRuntime() 通过此标志在无 process.env
  // 编译期内联的环境（如 CF Workers）下也能正确判定。配合
  // typecheck/browser.ts __setPiiCheckerForTest 的 production guard 确保
  // 浏览器/Workers 端无法关闭 PII analyzer。
  if (safeEnv('NODE_ENV') === 'production') {
    (globalThis as { __ASTER_PRODUCTION__?: boolean }).__ASTER_PRODUCTION__ = true;
  }

  // Skip on Edge runtime entirely (NextRequest API differs).
  // P0-R7: 改用 safeEnv 避免无 process 时崩溃
  const nextRuntime = safeEnv('NEXT_RUNTIME');
  if (nextRuntime && nextRuntime !== 'nodejs') return;

  // OpenNext on Cloudflare Workers reports NEXT_RUNTIME=nodejs even though
  // Worker secrets are bound differently. If we detect we're on CF (via
  // any of its signature env vars), warn instead of throwing so the worker
  // can boot; missing secrets will surface as runtime errors at the
  // specific call site (Stripe init, DB connect, …) rather than killing
  // every request at startup.
  const isCloudflareWorker =
    typeof globalThis.caches !== 'undefined' &&
    'default' in (globalThis.caches as unknown as { default?: unknown });

  if (isCloudflareWorker) {
    // 生产 Worker 经 HYPERDRIVE binding 连库，不设 DATABASE_URL。
    // 复用 db/binding 的判定（不含 postgres 驱动，edge 包可解析），
    // 避免把「有 binding」误报成「缺 DATABASE_URL」。
    const { hasDbBinding } = await import('./db/binding');
    validateEnvOrWarn(undefined, undefined, { hasDbBinding: hasDbBinding() });
    return;
  }

  validateEnvOrThrow();
}
