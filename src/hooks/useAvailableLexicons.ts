'use client';

/**
 * useAvailableLexicons — 订阅 aster-api 的 /api/v1/lexicons/stream，
 * 维护当前后端实际可用的 lexicon 集合。
 *
 * 设计：
 * - 首次挂载：立刻向 /api/v1/lexicons 拿快照（避免等 SSE 第一帧）
 * - 同时打开 EventSource 订阅 /api/v1/lexicons/stream 接收实时变更
 * - SSE 断线指数退避重连（1s, 2s, 4s, 8s, 上限 30s）
 * - 卸载时关闭 EventSource
 *
 * 不变式：返回的 `lexicons` 永远是一个有序数组（按 id），方便 React diff 稳定
 */

import { useEffect, useState } from 'react';
import { resolvePolicyApiBaseUrl } from '@/lib/policy-api-url';

const API_BASE =
  resolvePolicyApiBaseUrl(process.env.NEXT_PUBLIC_ASTER_POLICY_API_URL);

export interface LexiconInfo {
  id: string;
  name: string;
  direction: 'ltr' | 'rtl';
}

export interface UseAvailableLexiconsResult {
  /** 当前后端可用 lexicon 列表（已按 id 排序） */
  lexicons: LexiconInfo[];
  /** 加载状态 */
  loading: boolean;
  /** 是否处于 SSE 连接中（用于 UI 显示连接状态） */
  connected: boolean;
  /** 错误信息（如有） */
  error: string | null;
}

/**
 * 解析后端推送的 SSE data 行。
 *
 * 后端约定：data 是 JSON 数组（同 GET /api/v1/lexicons 形状），
 * 或者字符串 "heartbeat"（前端忽略）。
 */
function parseFrame(raw: string): LexiconInfo[] | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '"heartbeat"' || trimmed === 'heartbeat') return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return null;
    return parsed as LexiconInfo[];
  } catch {
    return null;
  }
}

export function useAvailableLexicons(): UseAvailableLexiconsResult {
  const [lexicons, setLexicons] = useState<LexiconInfo[]>([]);
  // M2：保持 loading=true，直到我们**真正**收到一次后端响应（快照成功 或 SSE 第一帧）。
  // 快照失败时**不要**把 loading 翻 false —— 否则 LanguageSwitcher 会把 lexicons=[]
  // 当成"后端只剩 en"的事实，强制把非 en 用户踢回 en。
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // R4-FE-M: per-effect cancellation token —— StrictMode 下两次 effect 各有
    // 自己的 `cancelled`，第一次 cleanup 不会影响第二次 effect 的 callback。
    let cancelled = false;
    // R3：SSE 一旦发过帧就算"权威"。后续慢响应的 snapshot 不再覆盖。
    // 也用 closure-local 而非 ref，避免 StrictMode 两次 effect 共享状态
    let sseAuthoritative = false;

    let retryDelay = 1000;
    const MAX_RETRY = 30_000;
    let currentEventSource: EventSource | null = null;
    let currentRetryTimer: ReturnType<typeof setTimeout> | null = null;

    // 1) 快照拉取（即时）。成功 → 解锁；失败 → 保持 loading，等 SSE
    const abortController = new AbortController();
    fetch(`${API_BASE}/api/v1/lexicons`, { signal: abortController.signal })
      .then(r => {
        if (!r.ok) throw new Error(`snapshot HTTP ${r.status}`);
        return r.json();
      })
      .then((data: LexiconInfo[]) => {
        if (cancelled) return;
        // R3：如果 SSE 已经发过权威帧，snapshot 的"旧"数据不能覆盖
        if (sseAuthoritative) return;
        setLexicons(data);
        setLoading(false);
        setError(null);
      })
      .catch(e => {
        if (cancelled || e.name === 'AbortError') return;
        // 快照失败不致命，且**不要**翻 loading 为 false —— 让 UI 继续显示 loading
        // 直到 SSE 第一帧到达或用户手动刷新
        setError(`failed to load snapshot: ${e.message}`);
      });

    // 2) SSE 订阅 + 自动重连
    function connect() {
      if (cancelled) return;
      const es = new EventSource(`${API_BASE}/api/v1/lexicons/stream`);
      currentEventSource = es;

      es.onopen = () => {
        if (cancelled) return;
        setConnected(true);
        setError(null);
        retryDelay = 1000; // 成功连上则重置退避
      };

      es.onmessage = (event) => {
        if (cancelled) return;
        const parsed = parseFrame(event.data);
        if (parsed !== null) {
          sseAuthoritative = true;
          setLexicons(parsed);
          setLoading(false);
        }
        // heartbeat 帧静默丢弃
      };

      es.onerror = () => {
        if (cancelled) return;
        setConnected(false);
        es.close();
        currentEventSource = null;
        // 指数退避重连
        currentRetryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY);
      };
    }
    connect();

    return () => {
      cancelled = true;
      abortController.abort();
      if (currentRetryTimer) {
        clearTimeout(currentRetryTimer);
        currentRetryTimer = null;
      }
      if (currentEventSource) {
        currentEventSource.close();
        currentEventSource = null;
      }
    };
  }, []);

  return { lexicons, loading, connected, error };
}
