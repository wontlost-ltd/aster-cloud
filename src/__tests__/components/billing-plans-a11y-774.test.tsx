// @vitest-environment jsdom
/**
 * #774：套餐页的结算币种下拉缺可访问名称（axe select-name，critical），月付 / 年付切换不暴露选中态。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), usePathname: () => '/billing/plans', useRouter: () => ({ push: vi.fn() }) }));

import { PlansContent } from '@/app/[locale]/(dashboard)/billing/plans/plans-content';

// 套餐名 / 功能文案只需字符串占位：任意 key 都返回 key 名
const keys = () => new Proxy({} as Record<string, string>, { get: (_t, k) => String(k) });
const translations = new Proxy({} as Record<string, unknown>, {
  get: (_t, k) => {
    if (k === 'currencyLabel') return 'Billing currency';
    if (k === 'intervalLabel') return 'Billing interval';
    if (k === 'monthly') return 'Monthly';
    if (k === 'yearly') return 'Yearly';
    if (k === 'currencies') return { USD: 'USD', CNY: 'CNY', EUR: 'EUR' };
    if (k === 'faq') return { title: 'FAQ', productQuestions: 'p', billingQuestions: 'b', items: {} };
    if (k === 'plans') return { names: keys(), features: keys() };
    if (k === 'nav') return { dashboard: 'Dashboard', billing: 'Billing' };
    return String(k);
  },
});

describe('PlansContent a11y (#774)', () => {
  it('names the currency select and exposes the selected billing interval', () => {
    render(
      <PlansContent currentPlan="free" trialEndsAt={null} initialUsage={null} defaultCurrency="USD" translations={translations as never} locale="en" />,
    );
    expect(screen.getByRole('combobox', { name: 'Billing currency' })).toBeTruthy();
    const group = screen.getByRole('group', { name: 'Billing interval' });
    const monthly = screen.getByRole('button', { name: 'Monthly' });
    expect(group.contains(monthly)).toBe(true);
    expect(monthly.getAttribute('aria-pressed')).toBe('true');
    const yearly = screen.getByRole('button', { name: /^Yearly/ });
    fireEvent.click(yearly);
    expect(yearly.getAttribute('aria-pressed')).toBe('true');
    expect(monthly.getAttribute('aria-pressed')).toBe('false');
  });
});
