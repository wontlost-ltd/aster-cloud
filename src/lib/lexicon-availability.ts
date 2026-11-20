/**
 * @module lib/lexicon-availability
 *
 * 中间件 + Server Components 共享的"当前后端 lexicon 可用性"查询逻辑。
 *
 * 单独抽出来：让 Edge runtime 的纯函数 fetch + cache 行为可被 vitest 单元测试。
 * R5-FE-Polish-3。
 */

import { locales, defaultLocale, type Locale } from '@/i18n/config';
import { safeEnv } from '@/lib/runtime/safe-env';
import { resolvePolicyApiBaseUrl } from '@/lib/policy-api-url';

export interface AvailabilityResult {
  /**
   * R6-FE-Polish-3: ReadonlySet 让 caller 不能 mutate 内部 cache。
   * 实际返回的对象仍是同一 Set 引用（不 copy），但 type 阻止误用。
   */
  readonly available: ReadonlySet<Locale>;
  readonly authoritative: boolean;
}

/**
 * 内部状态：模块级缓存。
 *
 * Edge runtime 会在同一 worker 实例内复用 module —— 缓存自然跨请求生效。
 * 每个 cold-start 新 worker 起空缓存。
 */
let cachedAvailable: Set<Locale> | null = null;
let cachedAt = 0;

/**
 * R8-FE-2: internal cache mutation API。**仅供测试导入**。
 *
 * 防御层：
 *  1. 符号名带 `__TEST_ONLY__` —— grep / 代码审查可见
 *  2. 仅经 `lib/__internal__/lexicon-availability-test-helpers.ts` 中转访问
 *     —— 单一来源便于 ESLint `no-restricted-imports` 拦截
 *  3. **运行时硬阻断**：production build 调用会抛 —— 即使 lint 被绕过，
 *     prod 也无法静默破坏 cache
 */
export function __TEST_ONLY__resetCache(): void {
  if (safeEnv('NODE_ENV') === 'production') {
    throw new Error(
      '__TEST_ONLY__resetCache called in production build — this is a test-only API. ' +
      'If you see this, a test helper leaked into a non-test bundle.'
    );
  }
  cachedAvailable = null;
  cachedAt = 0;
}

const LEXICON_TTL_MS = 15_000;
const LEXICON_FETCH_TIMEOUT_MS = 2_000;
// P0-R10: module-load 阶段裸读 process.env 在无 process 全局的 edge
// runtime（CF middleware / browser）抛 ReferenceError，整个 middleware
// 拒绝加载。通过 safeEnv 安全读取。
const ASTER_API_BASE =
  resolvePolicyApiBaseUrl(safeEnv('NEXT_PUBLIC_ASTER_POLICY_API_URL'));

function lexiconIdToUiLocale(lexId: string): string {
  return lexId.split('-')[0].toLowerCase();
}

/**
 * 返回当前后端可用 UI locale 的交集 + authoritative 标志。
 *
 * 三态：
 *  - fresh cache 或 fresh fetch → authoritative=true
 *  - stale cache + refresh-fail → authoritative=false（保留 stale 给非破坏性显示）
 *  - 冷启动 + 后端不可达 → authoritative=false, available={defaultLocale}
 */
export async function fetchAvailable(): Promise<AvailabilityResult> {
  const now = Date.now();
  if (cachedAvailable && now - cachedAt < LEXICON_TTL_MS) {
    return { available: cachedAvailable, authoritative: true };
  }
  try {
    const r = await fetch(`${ASTER_API_BASE}/api/v1/lexicons`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(LEXICON_FETCH_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error('snapshot http ' + r.status);
    const arr = (await r.json()) as { id: string }[];
    const backendSet = new Set(arr.map((l) => lexiconIdToUiLocale(l.id)));
    const intersect = new Set<Locale>();
    for (const l of locales) {
      if (backendSet.has(l)) intersect.add(l);
    }
    if (intersect.size === 0) intersect.add(defaultLocale);
    cachedAvailable = intersect;
    cachedAt = now;
    return { available: intersect, authoritative: true };
  } catch {
    if (cachedAvailable) {
      return { available: cachedAvailable, authoritative: false };
    }
    return {
      available: new Set<Locale>([defaultLocale]),
      authoritative: false,
    };
  }
}
