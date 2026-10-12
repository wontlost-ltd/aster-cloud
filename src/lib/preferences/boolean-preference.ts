/**
 * @module lib/preferences/boolean-preference
 *
 * 浏览器本地（localStorage）持久化的布尔偏好，供 React 组件订阅。
 *
 * <p>为什么要单独抽出来：站内助手开关（assistant-context）与编辑器 AI 行内补全开关
 * 都是「纯客户端 UI 偏好、按浏览器持久、需要跨标签页同步」，读写逻辑完全相同。
 * 这里把那套 useSyncExternalStore 适配写成可复用的工厂，新偏好不再复制一份。
 *
 * <p>约束（与 assistant-context 的设计说明一致）：
 * - getSnapshot 必须在值未变时返回同一个值，故维护缓存，只在写入或 storage 事件时失效；
 * - 服务端快照固定为默认值，首帧 HTML 与 SSR 一致，不会 hydration mismatch；
 * - 存储不可用（隐私模式等）时退回默认值，本次会话内写入仍生效；
 * - storage 事件不在当前标签页触发，写入时手动通知本页订阅者。
 */
'use client';

import { useCallback, useSyncExternalStore } from 'react';

export interface BooleanPreference {
  /** localStorage 键名。 */
  readonly key: string;
  /** 未设置或存储不可用时的取值。 */
  readonly defaultValue: boolean;
  /** 非 React 场景读取当前值（服务端恒为默认值）。 */
  read(): boolean;
  /** 写入并通知所有订阅者（本标签页立即生效，其他标签页经 storage 事件同步）。 */
  write(value: boolean): void;
  /** useSyncExternalStore 订阅函数。 */
  subscribe(onChange: () => void): () => void;
}

export function createBooleanPreference(key: string, defaultValue: boolean): BooleanPreference {
  const listeners = new Set<() => void>();
  let cached: boolean | null = null;

  const read = (): boolean => {
    if (typeof window === 'undefined') return defaultValue;
    if (cached === null) {
      try {
        const raw = window.localStorage.getItem(key);
        cached = raw === null ? defaultValue : raw === 'true';
      } catch {
        cached = defaultValue;
      }
    }
    return cached;
  };

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const write = (value: boolean): void => {
    cached = value;
    try {
      window.localStorage.setItem(key, String(value));
    } catch {
      /* 存不下也不让 UI 失效：本次会话内仍按 value 生效 */
    }
    notify();
  };

  const subscribe = (onChange: () => void): (() => void) => {
    listeners.add(onChange);
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) {
        cached = null;
        onChange();
      }
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(onChange);
      window.removeEventListener('storage', onStorage);
    };
  };

  return { key, defaultValue, read, write, subscribe };
}

const noopSubscribe = () => () => {};

/**
 * 订阅一个布尔偏好。
 *
 * @returns value 当前值；hydrating 为 true 表示客户端尚未读到真值（此时 value 是默认值，
 *          不应据此写回，否则会覆盖用户的真实设置）；setValue 写入。
 */
export function useBooleanPreference(pref: BooleanPreference): {
  value: boolean;
  hydrating: boolean;
  setValue: (value: boolean) => void;
} {
  const value = useSyncExternalStore(pref.subscribe, pref.read, () => pref.defaultValue);
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const setValue = useCallback((v: boolean) => pref.write(v), [pref]);
  return { value, hydrating: !mounted, setValue };
}
