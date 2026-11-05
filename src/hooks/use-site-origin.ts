'use client';

import { useSyncExternalStore } from 'react';

// origin 在页面生命周期内不变，无需订阅
const subscribe = () => () => {};
const getClientOrigin = () => window.location.origin;
const getServerOrigin = (): string | undefined => undefined;

/**
 * 当前页面的 origin。服务端渲染与 hydration 首帧返回 undefined，hydration 完成后返回
 * window.location.origin——两端首帧一致，不会因为渲染期读 window 产生 hydration 不一致（#714）。
 */
export function useSiteOrigin(): string | undefined {
  return useSyncExternalStore(subscribe, getClientOrigin, getServerOrigin);
}
