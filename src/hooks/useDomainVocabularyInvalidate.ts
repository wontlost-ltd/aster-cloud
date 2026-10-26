/**
 * useDomainVocabularyInvalidate —— 感知用户词汇变化，返回一个递增的 tick。
 *
 * 组件把 tick 放进依赖（Monaco 重新注册、重新拉词汇），tick 变化即刷新。
 *
 * 实现是轮询 GET /api/v1/domain-vocabularies/version（#608）：原先的 SSE 依赖进程内
 * EventEmitter，在 Cloudflare Workers 多 isolate 下事件永远收不到。版本号由数据库触发器
 * 单调递增，任何 isolate 读到的都一致。
 *
 * 轮询策略：
 * - 同一页面内所有 hook 实例共享**一个**轮询器（按 URL 登记），编辑器与词汇注册各自
 *   调用 hook 也只会产生一路请求；最后一个订阅者卸载时停止。
 * - 页面可见时每 {@link POLL_INTERVAL_MS} 一次；隐藏时暂停，重新可见/获得焦点时立即补一次。
 * - 首次拿到的版本只作基线，不触发 tick。
 * - 失败按指数退避，401（未登录）直接停止。
 *
 * 版本按用户计，不区分 domain/locale：任一范围变化都会让所有订阅者刷新一次，
 * 换来一次请求服务全页面；`match` 仅为兼容既有调用保留。
 */

import { useEffect, useState } from 'react';

interface UseInvalidateOptions {
  /** Skip polling (e.g., feature-flagged off or anonymous). */
  enabled?: boolean;
  /** 兼容既有调用；版本按用户计，不再按范围过滤。 */
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
  const { enabled = true, url = DEFAULT_URL } = options;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    return subscribe(url, () => setTick((n) => n + 1));
  }, [enabled, url]);

  return tick;
}

/** 一个 URL 对应一个轮询器；listeners 为空时拆除。 */
interface Poller {
  listeners: Set<() => void>;
  baseline: string | null;
  delay: number;
  stopped: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  wake: () => void;
}

const pollers = new Map<string, Poller>();

function subscribe(url: string, listener: () => void): () => void {
  const poller = pollers.get(url) ?? startPoller(url);
  poller.listeners.add(listener);
  return () => {
    poller.listeners.delete(listener);
    if (poller.listeners.size === 0) stopPoller(url, poller);
  };
}

function startPoller(url: string): Poller {
  const poller: Poller = {
    listeners: new Set(),
    baseline: null,
    delay: POLL_INTERVAL_MS,
    stopped: false,
    timer: null,
    wake: () => {
      if (document.visibilityState === 'visible') void poll(url, poller);
    },
  };
  pollers.set(url, poller);
  document.addEventListener('visibilitychange', poller.wake);
  window.addEventListener('focus', poller.wake);
  void poll(url, poller);
  return poller;
}

function stopPoller(url: string, poller: Poller): void {
  poller.stopped = true;
  if (poller.timer) clearTimeout(poller.timer);
  document.removeEventListener('visibilitychange', poller.wake);
  window.removeEventListener('focus', poller.wake);
  pollers.delete(url);
}

async function poll(url: string, poller: Poller): Promise<void> {
  if (poller.stopped || document.visibilityState === 'hidden') return;
  const version = await fetchVersion(url);
  if (poller.stopped) return;
  if (version === UNAUTHORIZED) {
    stopPoller(url, poller);
    return;
  }
  if (version === null) {
    poller.delay = Math.min(MAX_BACKOFF_MS, poller.delay * 2);
  } else {
    poller.delay = POLL_INTERVAL_MS;
    if (poller.baseline !== null && version !== poller.baseline) {
      poller.listeners.forEach((notify) => notify());
    }
    poller.baseline = version;
  }
  if (poller.timer) clearTimeout(poller.timer);
  poller.timer = setTimeout(() => void poll(url, poller), poller.delay);
}

const UNAUTHORIZED = Symbol('unauthorized');

/** 拉一次版本号；网络/服务端错误返回 null，未登录返回 UNAUTHORIZED。 */
async function fetchVersion(url: string): Promise<string | null | typeof UNAUTHORIZED> {
  try {
    const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    if (res.status === 401) return UNAUTHORIZED;
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
}
