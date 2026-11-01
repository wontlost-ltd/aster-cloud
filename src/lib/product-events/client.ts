'use client';

/**
 * 浏览器侧产品事件：同时上报站内事件表（/api/product-events，可 SQL 汇总）与 Mixpanel（既有看板）。
 *
 * 两路都 fail-soft；actor 由服务端从会话取，这里从不发送用户标识。
 */
import { track } from '@/lib/mixpanel';
import type { ProductEventName } from './definitions';

export function trackProductEvent(name: ProductEventName, properties?: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  track(name, properties);
  try {
    void fetch('/api/product-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, properties }),
      credentials: 'same-origin',
      // 落地页访问后用户可能立刻跳走，keepalive 让请求在卸载后仍能发出。
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // fetch 不可用（极旧浏览器 / 测试环境）时静默放弃
  }
}
