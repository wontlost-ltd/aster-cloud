// auto-downgrade cron：成员个人套餐到期只吊销其个人 key（ADR 0015 §5）。
//   - 吊销 where 必须含 teamId IS NULL：团队 key 的门槛由团队 owner 的套餐经解析器 / precheck 决定，
//     成员本人降级不能把它永久吊销（吊销不可逆，成员只会看到 401 revoked）
//   - 审计日志 api_keys_disabled 记的是被吊销的个人 key 数
//   - 降级邮件写明停用的是个人 API 访问
//   - 已是 free 的用户跳过；错误 CRON_SECRET → 401，不扫描

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  findMany: vi.fn(),
  update: vi.fn(),
  insertValues: vi.fn(),
  send: vi.fn(),
}));

vi.mock('@/lib/deployment-mode', () => ({ CAN_BILLING: true }));
vi.mock('@/lib/resend', () => ({ getResend: async () => ({ emails: { send: m.send } }) }));
vi.mock('@/lib/plan-gate-client', () => ({
  invalidatePlanCache: vi.fn(),
  invalidateApiKeyCache: vi.fn(),
}));
vi.mock('@/lib/snapshot-pusher', () => ({ pushUserSnapshot: vi.fn() }));
vi.mock('@/lib/prisma', () => ({
  db: {
    query: { users: { findMany: m.findMany } },
    update: m.update,
    insert: () => ({ values: m.insertValues }),
  },
  users: { id: 'users.id', subscriptionStatus: 'users.subscriptionStatus', gracePeriodEndsAt: 'users.gracePeriodEndsAt' },
  apiKeys: { id: 'apiKeys.id', userId: 'apiKeys.userId', teamId: 'apiKeys.teamId', revokedAt: 'apiKeys.revokedAt' },
  auditLogs: {},
}));
vi.mock('drizzle-orm', () => ({
  and: (...c: unknown[]) => ({ op: 'and', c }),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  lt: (col: unknown, val: unknown) => ({ op: 'lt', col, val }),
  inArray: (col: unknown, vals: unknown) => ({ op: 'inArray', col, vals }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
}));

type UpdateCall = { table: unknown; set: Record<string, unknown>; where: unknown };

const originalSecret = process.env.CRON_SECRET;
let updates: UpdateCall[];

function req(secret = 'cron-secret') {
  return new NextRequest('https://example.test/api/cron/auto-downgrade', {
    headers: { authorization: `Bearer ${secret}` },
  });
}

async function loadRoute() {
  vi.resetModules();
  return import('@/app/api/cron/auto-downgrade/route');
}

describe('/api/cron/auto-downgrade — 只吊销个人 key', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = 'cron-secret';
    updates = [];
    // update(table).set(v).where(w) 既可直接 await（users 降级），也可接 .returning()（吊销 key）
    m.update.mockImplementation((table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: (where: unknown) => {
          updates.push({ table, set, where });
          return { returning: async () => [{ id: 'k-personal-1' }, { id: 'k-personal-2' }] };
        },
      }),
    }));
    m.insertValues.mockResolvedValue(undefined);
    m.send.mockResolvedValue({ id: 'mail-1' });
    m.findMany.mockResolvedValue([
      { id: 'u1', email: 'u1@example.test', name: 'U1', plan: 'pro', gracePeriodEndsAt: new Date('2026-10-01T00:00:00Z') },
    ]);
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  });

  it('吊销 where = userId 本人 ∧ 未吊销 ∧ teamId IS NULL（团队 key 不动）', async () => {
    const { GET } = await loadRoute();
    const res = await GET(req());

    expect(res.status).toBe(200);
    const keyUpdates = updates.filter((u) => 'revokedAt' in u.set);
    expect(keyUpdates).toHaveLength(1);
    expect(keyUpdates[0].where).toEqual({
      op: 'and',
      c: [
        { op: 'eq', col: 'apiKeys.userId', val: 'u1' },
        { op: 'isNull', col: 'apiKeys.revokedAt' },
        { op: 'isNull', col: 'apiKeys.teamId' },
      ],
    });
  });

  it('审计日志与响应的 apiKeysDisabled 记被吊销的个人 key 数；邮件写明停用的是个人 API 访问', async () => {
    const { GET } = await loadRoute();
    const res = await GET(req());

    expect(m.insertValues).toHaveBeenCalledTimes(1);
    expect(m.insertValues.mock.calls[0][0]).toMatchObject({
      action: 'subscription.auto_downgraded',
      metadata: { previous_plan: 'pro', api_keys_disabled: 2 },
    });
    expect(await res.json()).toMatchObject({
      downgraded: 1,
      results: [{ userId: 'u1', apiKeysDisabled: 2, notified: true }],
    });
    const text = m.send.mock.calls[0][0].text as string;
    expect(text).toContain('• Personal API access has been disabled');
    expect(text).not.toContain('• API access has been disabled');
  });

  it('已是 free 的用户跳过，不吊销任何 key', async () => {
    m.findMany.mockResolvedValue([
      { id: 'u2', email: 'u2@example.test', name: null, plan: 'free', gracePeriodEndsAt: new Date('2026-10-01T00:00:00Z') },
    ]);
    const { GET } = await loadRoute();
    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(m.update).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ scanned: 1, downgraded: 0 });
  });

  it('错误 CRON_SECRET → 401，不扫描', async () => {
    const { GET } = await loadRoute();
    const res = await GET(req('wrong'));

    expect(res.status).toBe(401);
    expect(m.findMany).not.toHaveBeenCalled();
  });
});
