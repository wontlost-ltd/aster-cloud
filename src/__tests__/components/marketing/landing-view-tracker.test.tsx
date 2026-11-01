import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const track = vi.hoisted(() => vi.fn());
vi.mock('@/lib/product-events/client', () => ({ trackProductEvent: track }));

import {
  LANDING_VIEW_DEDUPE_MS,
  LandingViewTracker,
  shouldRecordLandingView,
} from '@/components/marketing/solutions/landing-view-tracker';

beforeEach(() => {
  track.mockClear();
  window.sessionStorage.clear();
});

describe('落地页访问去重', () => {
  it('同一标签页同一页面 30 分钟内只记一次，不同页面互不影响', () => {
    const t0 = 1_800_000_000_000;
    expect(shouldRecordLandingView('insurance-rating', t0)).toBe(true);
    expect(shouldRecordLandingView('insurance-rating', t0 + 60_000)).toBe(false);
    expect(shouldRecordLandingView('credit-decisions', t0 + 60_000)).toBe(true);
    expect(shouldRecordLandingView('insurance-rating', t0 + LANDING_VIEW_DEDUPE_MS + 1)).toBe(true);
  });

  it('重复挂载（刷新）只上报一次', () => {
    const { unmount } = render(<LandingViewTracker page="eligibility-rules" locale="en" />);
    unmount();
    render(<LandingViewTracker page="eligibility-rules" locale="en" />);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('landing_viewed', expect.objectContaining({ page: 'eligibility-rules', locale: 'en' }));
  });

  it('sessionStorage 不可用时照常记录', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(shouldRecordLandingView('agent-guardrails')).toBe(true);
    spy.mockRestore();
  });
});
