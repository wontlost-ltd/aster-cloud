/**
 * aster-api 基址的唯一回落规则（#824）。
 *
 * 线上与本地开发未配置 aster-api 地址时回落到生产 `policy.aster-lang.dev`——这是既有行为，保持不变。
 * 但测试进程（vitest / NODE_ENV=test）绝不能这样回落：集成测试漏设 env 时会把真实请求打到生产
 * （#824：team-policy-authz「设默认版本」向生产 Guard 部署端点发了一次请求）。
 *
 * 测试进程里改为 fail closed：
 *   - 未配置 → 回落到 {@link TEST_UNCONFIGURED_POLICY_API_URL}（本机 discard 端口，立刻 ECONNREFUSED）；
 *   - 显式配置成 `aster-lang.dev` 或其子域 → 同样替换成该地址，防止从 shell / .env 继承生产地址。
 * 不在模块加载时抛错：许多模块把基址算成模块级常量，抛错会让只 mock 了 fetch 的单测无法 import。
 *
 * 本模块会被 middleware 链与浏览器代码引用，只经 safeEnv 读环境变量（见 @/lib/runtime/safe-env）。
 * 调用方自己读 `process.env.NEXT_PUBLIC_*` 再传进来：Next 只内联字面量形式的 `process.env.X`。
 */
import { safeEnv } from '@/lib/runtime/safe-env';

/** 生产 aster-api（REST）。 */
export const PRODUCTION_POLICY_API_URL = 'https://policy.aster-lang.dev';

/** 生产 aster-api 预览 WebSocket。 */
export const PRODUCTION_POLICY_WS_URL = 'wss://policy.aster-lang.dev/ws/preview';

/** 测试进程未配置 aster-api 时的回落地址：本机 discard 端口（9），连接立即被拒，不经 DNS。 */
export const TEST_UNCONFIGURED_POLICY_API_URL = 'http://127.0.0.1:9';

/** 同上，WebSocket 形式。 */
export const TEST_UNCONFIGURED_POLICY_WS_URL = 'ws://127.0.0.1:9';

const PRODUCTION_DOMAIN = 'aster-lang.dev';

/** 当前进程是否为测试运行（vitest 会设置 VITEST；其它运行器约定 NODE_ENV=test）。 */
export function isTestRuntime(): boolean {
  return Boolean(safeEnv('VITEST')) || safeEnv('NODE_ENV') === 'test';
}

/** URL 是否指向生产域 `aster-lang.dev`（含任意子域）；无法解析的串按否处理。 */
export function isProductionAsterHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === PRODUCTION_DOMAIN || host.endsWith(`.${PRODUCTION_DOMAIN}`);
  } catch {
    return false;
  }
}

function resolve(candidates: Array<string | undefined>, production: string, testFallback: string): string {
  const configured = candidates.map((value) => value?.trim()).find(Boolean);
  if (!isTestRuntime()) return configured ?? production;
  return configured && !isProductionAsterHost(configured) ? configured : testFallback;
}

/**
 * 按优先级取第一个非空的已配置地址；都没有时生产环境回落生产地址，测试进程回落到不可达的本机地址。
 *
 * @param configured 按优先级排列的候选（通常是 ASTER_POLICY_API_INTERNAL_URL、NEXT_PUBLIC_ASTER_POLICY_API_URL）
 */
export function resolvePolicyApiBaseUrl(...configured: Array<string | undefined>): string {
  return resolve(configured, PRODUCTION_POLICY_API_URL, TEST_UNCONFIGURED_POLICY_API_URL);
}

/** {@link resolvePolicyApiBaseUrl} 的 WebSocket 版本。 */
export function resolvePolicyWsUrl(...configured: Array<string | undefined>): string {
  return resolve(configured, PRODUCTION_POLICY_WS_URL, TEST_UNCONFIGURED_POLICY_WS_URL);
}
