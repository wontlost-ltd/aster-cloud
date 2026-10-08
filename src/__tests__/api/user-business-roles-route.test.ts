import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PUT /api/user/business-roles（ADR 0042 §2.1，个人租户）：
 * 未登录 401 且不写库；合法 → 写本人 User 行并重推本人个人 key 快照；非法 → 400 invalid_business_role。
 */

const getSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth', () => ({ getSession: () => getSession() }));

const m = vi.hoisted(() => {
  const where = vi.fn();
  const set = vi.fn(() => ({ where }));
  return { update: vi.fn(() => ({ set })), set, where, refresh: vi.fn() };
});
vi.mock('@/lib/prisma', () => ({ db: { update: m.update }, users: { id: 'users.id' } }));
vi.mock('drizzle-orm', () => ({ eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }) }));
vi.mock('@/lib/api-keys', () => ({ refreshPersonalKeySnapshots: m.refresh }));

import { PUT } from '@/app/api/user/business-roles/route';

const put = (body: string) =>
  new Request('http://cloud.test/api/user/business-roles', { method: 'PUT', body, headers: { 'content-type': 'application/json' } });

describe('PUT /api/user/business-roles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    m.refresh.mockResolvedValue(1);
  });

  it('未登录 → 401，不写库', async () => {
    getSession.mockResolvedValue(null);
    const res = await PUT(put(JSON.stringify({ businessRoles: ['DPO'] })));
    expect(res.status).toBe(401);
    expect(m.update).not.toHaveBeenCalled();
  });

  it('合法 → 200，写本人行（归一后）并重推本人个人 key 快照', async () => {
    const res = await PUT(put(JSON.stringify({ businessRoles: [' DPO ', 'CISO', 'DPO'] })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ businessRoles: ['DPO', 'CISO'] });
    expect(m.set).toHaveBeenCalledWith({ businessRoles: ['DPO', 'CISO'] });
    expect(m.where).toHaveBeenCalledWith({ op: 'eq', col: 'users.id', val: 'u1' });
    expect(m.refresh).toHaveBeenCalledWith('u1');
  });

  it('清空 → 200，写入空数组', async () => {
    const res = await PUT(put(JSON.stringify({ businessRoles: [] })));
    expect(res.status).toBe(200);
    expect(m.set).toHaveBeenCalledWith({ businessRoles: [] });
  });

  it('非法角色 / 缺字段 → 400 invalid_business_role；坏 JSON → 400；均不写库', async () => {
    for (const body of [{ businessRoles: ['数据保护官'] }, { businessRoles: 'DPO' }, {}]) {
      const res = await PUT(put(JSON.stringify(body)));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_business_role' });
    }
    expect((await PUT(put('{not json'))).status).toBe(400);
    expect(m.update).not.toHaveBeenCalled();
  });

  it('快照重推失败不影响已提交的写入 → 仍 200', async () => {
    m.refresh.mockRejectedValue(new Error('aster-api down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await PUT(put(JSON.stringify({ businessRoles: ['DPO'] })));
    expect(res.status).toBe(200);
  });
});
