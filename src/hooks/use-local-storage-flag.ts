'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * localStorage 里的布尔开关（值为 '1' / '0'），水合安全（#774 水合错误 #418 的根因修复）。
 *
 * 不能在 useState 惰性初始化里读 localStorage：服务端读不到，存过开关的用户客户端首渲与服务端 HTML 不一致。
 * useSyncExternalStore 在水合期间用服务端快照（false，与 SSR 一致），水合完成后切到 localStorage 的真实值。
 * 写入经同一个 store：本标签页内派发事件通知所有订阅者，其他标签页靠原生 storage 事件，状态只有一个来源。
 */
const LOCAL_EVENT = 'aster:local-storage-flag';

function subscribe(onChange: () => void): () => void {
  // 其他标签页写入了存储：以存储为准，丢掉本标签页的内存回退
  const onStorage = (e: StorageEvent) => {
    if (e.key) memory.delete(e.key);
    onChange();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(LOCAL_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(LOCAL_EVENT, onChange);
  };
}

const serverSnapshot = () => false;

/** 存储不可用（隐私模式、配额、被禁用）时的会话内回退值，按 key 记；同一个 store，界面照常响应 */
const memory = new Map<string, boolean>();

export function useLocalStorageFlag(key: string): [boolean, (next: boolean) => void] {
  const read = useCallback(() => {
    if (memory.has(key)) return memory.get(key) as boolean;
    try {
      return window.localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  }, [key]);
  const value = useSyncExternalStore(subscribe, read, serverSnapshot);
  const set = useCallback(
    (next: boolean) => {
      try {
        window.localStorage.setItem(key, next ? '1' : '0');
        memory.delete(key);
      } catch {
        // 存储不可用：记在内存里，本次会话内照常生效（刷新后不保留）
        memory.set(key, next);
      }
      window.dispatchEvent(new Event(LOCAL_EVENT));
    },
    [key],
  );
  return [value, set];
}
