// admin 结构词别名授权接口（ADR 0022 结构词扩展）POST 幂等性测试。
//
// 授予是单条 INSERT … ON CONFLICT DO NOTHING：DB 层 partial UNIQUE(userId) WHERE revokedAt IS NULL
// 保证「至多一条活跃」，重复 / 并发授予都返回幂等成功。不再先查后插——那一步 SELECT 会被
// Hyperdrive 缓存，撤销后窗口内再授予会被旧结果跳过（#614）。真实唯一索引行为见
// integration/policy-trash-and-grants.integration.test.ts。

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/admin-auth', () => ({ requireAdmin: vi.fn() }));
vi.mock('@/lib/license-write-gate', () => ({ requireLicenseWriteOk: vi.fn() }));
vi.mock('@/lib/prisma', () => ({
  db: {
    insert: vi.fn(),
  },
  structuralAliasGrants: { userId: {}, revokedAt: {} },
  users: {},
}));

import { POST } from '@/app/api/admin/structural-alias-grants/route';
import { requireAdmin } from '@/lib/admin-auth';
import { requireLicenseWriteOk } from '@/lib/license-write-gate';
import { db } from '@/lib/prisma';

function req(body: unknown) {
  return new Request('http://localhost/api/admin/structural-alias-grants', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

describe('POST /api/admin/structural-alias-grants — 授予幂等', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireLicenseWriteOk).mockResolvedValue(null);
    vi.mocked(requireAdmin).mockResolvedValue({ userId: 'admin-1' } as never);
  });

  it('userId 缺失 → 400', async () => {
    const r = await POST(req({}));
    expect(r.status).toBe(400);
  });

  function mockInsert(onConflictDoNothing: ReturnType<typeof vi.fn>) {
    const values = vi.fn(() => ({ onConflictDoNothing }));
    vi.mocked(db.insert).mockReturnValue({ values } as never);
    return values;
  }

  it('授予：插入活跃授权并以 ON CONFLICT DO NOTHING 保证幂等 → ok', async () => {
    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    const values = mockInsert(onConflictDoNothing);

    const r = await POST(req({ userId: 'user-9' }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-9', grantedBy: 'admin-1' }),
    );
    expect(onConflictDoNothing).toHaveBeenCalled();
  });

  it('非唯一冲突的 DB 错误仍冒泡（不静默吞）', async () => {
    mockInsert(vi.fn().mockRejectedValue(Object.assign(new Error('connection reset'), { code: '08006' })));

    await expect(POST(req({ userId: 'user-9' }))).rejects.toThrow('connection reset');
  });
});
