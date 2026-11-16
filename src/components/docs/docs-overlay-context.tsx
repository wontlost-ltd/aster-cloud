'use client';

import { createContext, useCallback, useContext, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * 登录后「文档」overlay 的开关 + 当前文档 slug 状态。
 *
 * sidebar 的「文档」入口与 <DocsOverlay> 通过此 context 通信：点入口 openDocs()
 * 打开 overlay 并加载首页（或上次浏览页），点目录项 navigate(slug) 切换内容。
 * URL 不变（overlay 不导航），符合「不跳走 dashboard、看完回原页」的诉求。
 */
type DocsOverlayState = {
  open: boolean;
  /** 当前文档 slug（/docs/<slug>），如 'getting-started/overview' */
  slug: string;
  openDocs: (slug?: string) => void;
  navigate: (slug: string) => void;
  close: () => void;
};

const DEFAULT_SLUG = 'getting-started/overview';

const DocsOverlayContext = createContext<DocsOverlayState | null>(null);

export function DocsOverlayProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState(DEFAULT_SLUG);

  const openDocs = useCallback((next?: string) => {
    if (next) setSlug(next);
    setOpen(true);
  }, []);

  const navigate = useCallback((next: string) => {
    setSlug(next);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  return (
    <DocsOverlayContext.Provider value={{ open, slug, openDocs, navigate, close }}>
      {children}
    </DocsOverlayContext.Provider>
  );
}

/**
 * 不在 DocsOverlayProvider 内时返回 null，不抛错。
 * 供可能挂在 dashboard 外（或单测里不带 provider）的「了解更多」链接使用：没有浮层就退回普通 /docs 链接。
 */
export function useOptionalDocsOverlay(): DocsOverlayState | null {
  return useContext(DocsOverlayContext);
}

export function useDocsOverlay(): DocsOverlayState {
  const ctx = useContext(DocsOverlayContext);
  if (!ctx) {
    throw new Error('useDocsOverlay must be used within <DocsOverlayProvider>');
  }
  return ctx;
}
