'use client';

import { useEffect } from 'react';
import { readAttribution } from '@/lib/product-events/definitions';
import { trackProductEvent } from '@/lib/product-events/client';
import type { SolutionSlug } from '@/lib/solutions';

/** 同一标签页内同一落地页 30 分钟内只记一次访问（刷新、来回切换不重复计数）。 */
export const LANDING_VIEW_DEDUPE_MS = 30 * 60 * 1000;

function storageKey(page: SolutionSlug): string {
  return `aster.landingViewed.${page}`;
}

/** 返回本次是否应记录；sessionStorage 不可用（隐私模式 / 禁用存储）时照常记录。 */
export function shouldRecordLandingView(page: SolutionSlug, now = Date.now()): boolean {
  try {
    const last = Number(window.sessionStorage.getItem(storageKey(page)));
    if (Number.isFinite(last) && last > 0 && now - last < LANDING_VIEW_DEDUPE_MS) return false;
    window.sessionStorage.setItem(storageKey(page), String(now));
  } catch {
    // 存储不可用：无法去重，按一次访问记录
  }
  return true;
}

/** 落地页访问埋点：页面 slug、语种与来源归因（utm_* + 外站 referrer 主机名）。不渲染任何内容。 */
export function LandingViewTracker({ page, locale }: { page: SolutionSlug; locale: string }) {
  useEffect(() => {
    if (!shouldRecordLandingView(page)) return;
    trackProductEvent('landing_viewed', {
      page,
      locale,
      ...readAttribution(window.location.href, document.referrer),
    });
  }, [page, locale]);
  return null;
}
