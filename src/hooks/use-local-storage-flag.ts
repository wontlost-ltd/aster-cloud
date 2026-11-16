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
  window.addEventListener('storage', onChange);
  window.addEventListener(LOCAL_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(LOCAL_EVENT, onChange);
  };
}

const serverSnapshot = () => false;

export function useLocalStorageFlag(key: string): [boolean, (next: boolean) => void] {
  const read = useCallback(() => {
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
      } catch {
        // 存储不可用（隐私模式等）：本次会话内不记忆，界面照常
      }
      window.dispatchEvent(new Event(LOCAL_EVENT));
    },
    [key],
  );
  return [value, set];
}
