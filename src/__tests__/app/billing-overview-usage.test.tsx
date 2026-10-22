// @vitest-environment node
/*
 * 账单概览的 API 用量（生产 E2E F26）：cloud REST 调用与 Policy 执行 API 是两个独立计量，
 * 必须分行、分别命名展示；Policy 执行 API 一行取 owner 配额池（与 dashboard 用量卡片同口径），
 * 查询失败时只隐藏该行。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// 配额池用量桩：用普通函数而非 vi.fn 承载拒绝分支，记录调用参数供断言
const h = vi.hoisted(() => ({
  calls: [] as unknown[][],
  result: 0 as number | Error,
}));

vi.mock('@/lib/deployment-mode', () => ({ CAN_BILLING: true }));
vi.mock('next/navigation', () => ({ notFound: vi.fn(), redirect: vi.fn() }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (ns: string) => (key: string) => `${ns}.${key}`,
  getLocale: async () => 'zh',
}));
vi.mock('@/lib/auth', () => ({ getSession: async () => ({ user: { id: 'u1', trialEndsAt: null } }) }));
vi.mock('@/lib/usage', () => ({
  getUsageStats: async () => ({
    plan: 'pro',
    usage: { executions: 3, executionsLimit: 5000, apiCalls: 0, apiCallsLimit: 5000, policies: 18, policiesLimit: 25 },
  }),
}));
vi.mock('@/lib/api-quota-pool', () => ({
  countOwnerPoolUsage: async (...args: unknown[]) => {
    h.calls.push(args);
    if (h.result instanceof Error) throw h.result;
    return h.result;
  },
  currentPeriodMonth: () => '2026-10',
}));
vi.mock('@/lib/prisma', () => ({
  db: { select: () => ({ from: () => ({ innerJoin: () => ({ where: async () => [{ c: 1 }] }) }) }) },
  teams: { id: 'teams.id', ownerId: 'teams.ownerId' },
  teamMembers: { teamId: 'teamMembers.teamId' },
}));

import BillingOverviewPage from '@/app/[locale]/(dashboard)/billing/page';

async function render(): Promise<string> {
  return renderToStaticMarkup(await BillingOverviewPage());
}

describe('账单概览 API 用量', () => {
  beforeEach(() => {
    h.calls = [];
    h.result = 0;
  });

  it('两个计量分行且分别命名：Policy 执行 API 取配额池用量，REST 行取 UsageRecord', async () => {
    h.result = 47;

    const html = await render();

    expect(h.calls).toEqual([['u1', '2026-10']]);
    expect(html).toContain('billing.policyApiCallsThisMonth');
    expect(html).toContain('47 / 5,000');
    expect(html).toContain('billing.restApiCallsThisMonth');
    expect(html).toContain('0 / 5,000');
    expect(html).not.toContain('billing.apiCallsThisMonth');
  });

  it('配额池查询失败：隐藏 Policy 执行 API 行，其余照常渲染', async () => {
    h.result = new Error('relation "ApiCallRecord" does not exist');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const html = await render();

    expect(html).not.toContain('billing.policyApiCallsThisMonth');
    expect(html).toContain('billing.restApiCallsThisMonth');
    expect(spy).toHaveBeenCalledWith('[billing] policy api usage unavailable', expect.any(Error));
    spy.mockRestore();
  });
});
