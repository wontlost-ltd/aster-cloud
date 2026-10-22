/*
 * 首页 AHA 卡片（生产 E2E F25）：文案全部走翻译（zh/de/hi 不再露英文）；
 * 未达成但已有策略时不渲染「发布你的第一个策略 / 创建策略」引导。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const h = vi.hoisted(() => ({ useApi: vi.fn() }));

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${ns}.${key}:${JSON.stringify(values)}` : `${ns}.${key}`,
}));
vi.mock('@/lib/api', () => ({ useApi: h.useApi }));

import { AhaStatusCard } from '@/components/dashboard/aha-status-card';

afterEach(cleanup);

function pending(over: Record<string, unknown> = {}) {
  return { achieved: false, hoursSinceSignup: 100, hoursRemaining: 0, ahaWindowHours: 24, expired: true, ...over };
}

describe('AhaStatusCard', () => {
  it('超窗未达成且无策略：渲染本地化的「发布首个策略」引导', () => {
    h.useApi.mockReturnValue({ data: pending({ hasPolicies: false }), isLoading: false });
    render(<AhaStatusCard locale="zh" />);
    expect(screen.getByText('dashboard.aha.publishFirstTitle')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'dashboard.aha.createPolicy' }).getAttribute('href')).toBe('/zh/policies/new');
    expect(screen.queryByText(/Publish your first policy/i)).toBeNull();
  });

  it('未达成但已有策略：卡片不渲染', () => {
    h.useApi.mockReturnValue({ data: pending({ hasPolicies: true }), isLoading: false });
    const { container } = render(<AhaStatusCard locale="zh" />);
    expect(container.textContent).toBe('');
  });

  it('窗口内挑战：小时数经翻译插值', () => {
    h.useApi.mockReturnValue({ data: pending({ expired: false, hoursRemaining: 5.25, hasPolicies: false }), isLoading: false });
    render(<AhaStatusCard locale="de" />);
    expect(screen.getByText('dashboard.aha.challengeBody:{"hours":24}')).toBeTruthy();
    expect(screen.getByText('dashboard.aha.hoursRemaining:{"hours":"5.3"}')).toBeTruthy();
  });

  it('已达成：庆祝文案经翻译', () => {
    h.useApi.mockReturnValue({
      data: { achieved: true, achievedAt: '2026-10-01', hoursToFirst: 6, withinAhaWindow: true, ahaWindowHours: 24 },
      isLoading: false,
    });
    render(<AhaStatusCard locale="hi" />);
    expect(screen.getByText('dashboard.aha.achievedTitle')).toBeTruthy();
    expect(screen.getByText('dashboard.aha.hoursAfterSignup:{"hours":6}')).toBeTruthy();
  });
});
