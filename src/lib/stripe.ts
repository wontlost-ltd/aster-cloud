/* @deployment-mode-hot-gate
 * reason: dynamic import of stripe SDK + direct __DEPLOYMENT_MODE__ macro
 *         required for proper DCE. Importing IS_SAAS from deployment-mode
 *         module leaves the dead `await import('stripe')` branch in the
 *         bundle (Webpack treats dynamic imports as side-effectful even
 *         when the wrapping branch is dead). Spike report §3.2 / §3.3
 *         empirically established this. The on-prem build also aliases
 *         `stripe` to false in next.config.ts as belt-and-suspenders.
 */

// 注意：本模块**只能**被 SaaS 模式下的代码路径访问。On-prem build 不会
// 物理包含 stripe npm package（webpack.resolve.alias.stripe = false）—
// 任何在 on-prem 调用本模块函数的代码会在 dynamic import 时抛错。
// 路由层（webhook / portal / checkout）须先用 CAN_BILLING 守门返回 404，
// 避免错误冒到客户面前。

import type Stripe from 'stripe';

type StripeCtor = typeof Stripe;

let _stripeInstance: Stripe | null = null;
let _stripeCtorPromise: Promise<StripeCtor> | null = null;

async function loadStripeCtor(): Promise<StripeCtor> {
  // 直接 macro 引用让 terser 在 on-prem build 中折叠这个分支并消除
  // dynamic import 表达式 —— 否则 SDK 会被打入 on-prem bundle（128KB）。
  if (__DEPLOYMENT_MODE__ !== 'saas') {
    throw new Error(
      '[stripe] Stripe SDK is unavailable in on-prem build. ' +
        'Callers must gate by CAN_BILLING / IS_SAAS before reaching this module.',
    );
  }
  if (!_stripeCtorPromise) {
    // 缓存 Promise 而不是已 resolve 的值 —— 让并发的首次调用共享同一
    // 加载过程，避免多次 dynamic import。
    _stripeCtorPromise = import('stripe').then((mod) => mod.default);
  }
  return _stripeCtorPromise;
}

/**
 * 获取/初始化 Stripe SDK 实例。
 *
 * - 仅 SaaS 模式可用；on-prem 调用会立即 throw（route 层应已用 CAN_BILLING 拦下）
 * - Lazy init：首次调用时 dynamic import SDK + 实例化，后续复用
 * - 缺 STRIPE_SECRET_KEY 时 throw（与原行为一致）
 *
 * **breaking change**：此前的同步 `getStripe(): Stripe` 改为异步
 * `getStripe(): Promise<Stripe>`。原因：dynamic import 必须 await。
 * 所有调用方都已经在 async context（route handlers / cron / lib），改动安全。
 */
export async function getStripe(): Promise<Stripe> {
  // 直接 macro 检查放在函数顶部 —— 让 terser 在 on-prem build 把整个
  // 函数体（包括 process.env.STRIPE_SECRET_KEY 引用）折叠成单一 throw。
  // 否则 verify-on-prem-bundle 会把 secret env 名当残留泄漏报错。
  if (__DEPLOYMENT_MODE__ !== 'saas') {
    throw new Error(
      '[stripe] Stripe SDK is unavailable in on-prem build. ' +
        'Callers must gate by CAN_BILLING / IS_SAAS before reaching this module.',
    );
  }
  if (_stripeInstance) return _stripeInstance;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY is not set');
  }
  const StripeCtor = await loadStripeCtor();
  _stripeInstance = new StripeCtor(key, {
    // 随 stripe SDK 22.x 升级对齐其 pinned API 版本（clover→dahlia）。
    // ★apiVersion 被 stripe 写进**类型**(LatestApiVersion)：只 bump 包版本而不改
    //   这一行会直接 TS2322 失败。22.3.0→2026-06-24.dahlia；22.4.0→2026-07-29.dahlia；
    //   22.6.1→2026-08-26.dahlia。
    //   ★取值应从 SDK 自身读，不要照抄报错信息：
    //     node_modules/stripe/esm/apiVersion.d.ts 的 `ApiVersion` 即权威值。
    apiVersion: '2026-08-26.dahlia',
    typescript: true,
  });
  return _stripeInstance;
}
