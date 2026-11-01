'use client';

import { useEffect } from 'react';
import { readAttribution } from '@/lib/product-events/definitions';
import { trackProductEvent } from '@/lib/product-events/client';
import type { SolutionSlug } from '@/lib/solutions';

/** 落地页访问埋点：页面 slug、语种与来源归因（utm_* + 外站 referrer 主机名）。不渲染任何内容。 */
export function LandingViewTracker({ page, locale }: { page: SolutionSlug; locale: string }) {
  useEffect(() => {
    trackProductEvent('landing_viewed', {
      page,
      locale,
      ...readAttribution(window.location.href, document.referrer),
    });
  }, [page, locale]);
  return null;
}
