/**
 * useDomainVocabularyInvalidate —— 感知用户词汇变化，返回一个递增的 tick。
 *
 * 组件把 tick 放进依赖（Monaco 重新注册、重新拉词汇），tick 变化即刷新。
 *
 * 实现是轮询 GET /api/v1/domain-vocabularies/version（#608）：
 * 原先的 SSE 依赖进程内 EventEmitter，在 Cloudflare Workers 多 isolate 下
 * 发布与订阅不在同一 isolate，事件永远收不到。版本号由数据库推导，任何
 * isolate 都能给出一致结果。
 *
 * 轮询策略：
 * - 页面可见时每 {@link POLL_INTERVAL_MS} 一次；隐藏时暂停，重新可见/获得焦点时立即补一次。
 * - 首次拿到的版本只作基线，不触发 tick。
 * - 失败按指数退避，401（未登录）直接停止。
 */

import { useEffect, useState } from 'react';

interface UseInvalidateOptions {
  /** Skip polling (e.g., feature-flagged off or anonymous). */
  enabled?: boolean;
  /** 只关心某个 (domain, locale) 时传入，服务端按范围计算版本。 */
  match?: { domain?: string; locale?: string };
  /** Override the version URL (mostly for tests). */
  url?: string;
}

const DEFAULT_URL = '/api/v1/domain-vocabularies/version';
export const POLL_INTERVAL_MS = 20_000;
const MAX_BACKOFF_MS = 120_000;

export function useDomainVocabularyInvalidate(
  options: UseInvalidateOptions = {},
): number {
  const { enabled = true, match, url = DEFAULT_URL } = options;
  const domain = match?.domain;
  const locale = match?.locale;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const endpoint = buildVersionUrl(url, domain, locale);
    let cancelled = false;
    let stopped = false;
    let baseline: string | null = null;
    let delay = POLL_INTERVAL_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void poll(), ms);
    };

    const poll = async () => {
      if (cancelled || stopped) return;
      if (document.visibilityState === 'hidden') return;
      const version = await fetchVersion(endpoint);
      if (cancelled) return;
      if (version === UNAUTHORIZED) {
        stopped = true;
        return;
      }
      if (version === null) {
        delay = Math.min(MAX_BACKOFF_MS, delay * 2);
      } else {
        delay = POLL_INTERVAL_MS;
        if (baseline !== null && version !== baseline) setTick((n) => n + 1);
        baseline = version;
      }
      schedule(delay);
    };

    const wake = () => {
      if (document.visibilityState === 'visible') void poll();
    };

    void poll();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
    };
  }, [enabled, url, domain, locale]);

  return tick;
}

const UNAUTHORIZED = Symbol('unauthorized');

/** 拉一次版本号；网络/服务端错误返回 null，未登录返回 UNAUTHORIZED。 */
async function fetchVersion(endpoint: string): Promise<string | null | typeof UNAUTHORIZED> {
  try {
    const res = await fetch(endpoint, { credentials: 'same-origin', cache: 'no-store' });
    if (res.status === 401) return UNAUTHORIZED;
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
}

function buildVersionUrl(base: string, domain?: string, locale?: string): string {
  const params = new URLSearchParams();
  if (domain) params.set('domain', domain);
  if (locale) params.set('locale', locale);
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}
