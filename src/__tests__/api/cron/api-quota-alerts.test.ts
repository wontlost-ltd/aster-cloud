// api-quota-alerts cron：按配额 owner 共享池分组扫描（ADR 0015 §4）。
//   - select 的 userId 别名与 groupBy 必须是 api-quota-pool 导出的同一个 quotaOwnerKey 对象
//     （池定义单一来源；同一表达式对象才能保证 select 与 group by 渲染一致）
//   - 分组得到的 owner id 直接用于查 users / 发告警
//   - 错误 CRON_SECRET → 401，不扫描

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  quotaOwnerKey: { op: 'quotaOwnerKey' },
  select: vi.fn(),
  groupBy: vi.fn(),
  findFirst: vi.fn(),
}));

vi.mock('@/lib/deployment-mode', () => ({ CAN_BILLING: true }));
vi.mock('@/lib/resend', () => ({ getResend: async () => null }));
vi.mock('@/lib/api-quota-pool', () => ({
  quotaOwnerKey: m.quotaOwnerKey,
  currentPeriodMonth: () => '2026-10',
}));
vi.mock('@/lib/prisma', () => ({
  db: {
    select: m.select,
    query: { users: { findFirst: m.findFirst } },
    update: vi.fn(),
  },
  users: { id: 'users.id' },
  apiCallRecords: { periodMonth: 'periodMonth', status: 'status' },
}));
vi.mock('drizzle-orm', () => ({
  and: (...c: unknown[]) => ({ op: 'and', c }),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  sql: () => ({ op: 'sql' }),
}));

const originalSecret = process.env.CRON_SECRET;

function req(secret = 'cron-secret') {
  return new NextRequest('https://example.test/api/cron/api-quota-alerts', {
    headers: { authorization: `Bearer ${secret}` },
  });
}

async function loadRoute() {
  vi.resetModules();
  return import('@/app/api/cron/api-quota-alerts/route');
}

describe('/api/cron/api-quota-alerts — owner 共享池分组', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = 'cron-secret';
    m.select.mockReturnValue({ from: () => ({ where: () => ({ groupBy: m.groupBy }) }) });
    m.groupBy.mockResolvedValue([{ userId: 'owner-1', used: 10 }]);
    m.findFirst.mockResolvedValue({
      email: 'owner@example.test',
      plan: 'pro',
      priceLockedAt: null,
      legacyTier: null,
      apiQuotaWarn80SentAt: null,
      apiQuotaWarn100SentAt: null,
      apiQuotaWarn200SentAt: null,
    });
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  });

  it('select 别名 userId 与 groupBy 用同一个 quotaOwnerKey，按 owner 查用户', async () => {
    const { GET } = await loadRoute();
    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(m.select).toHaveBeenCalledTimes(1);
    expect(m.select.mock.calls[0][0].userId).toBe(m.quotaOwnerKey);
    expect(m.groupBy).toHaveBeenCalledTimes(1);
    expect(m.groupBy.mock.calls[0][0]).toBe(m.quotaOwnerKey);
    expect(m.findFirst.mock.calls[0][0].where).toEqual({ op: 'eq', col: 'users.id', val: 'owner-1' });
    expect(await res.json()).toMatchObject({ period: '2026-10', scanned: 1 });
  });

  it('错误 CRON_SECRET → 401，不扫描', async () => {
    const { GET } = await loadRoute();
    const res = await GET(req('wrong'));

    expect(res.status).toBe(401);
    expect(m.select).not.toHaveBeenCalled();
  });
});
