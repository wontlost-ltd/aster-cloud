import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  select: vi.fn(),
  from: vi.fn(),
  leftJoin: vi.fn(),
  where: vi.fn(),
  authConfiguration: { current: null as unknown },
}));

vi.mock('next-auth', () => ({ default: (config: unknown) => {
  h.authConfiguration.current = config;
  return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
} }));
vi.mock('@/lib/prisma', () => ({
  getDb: () => ({ select: h.select }),
  db: {},
  users: { id: 'users.id' },
  platformSettings: { key: 'platformSettings.key', value: 'platformSettings.value' },
}));

import '@/auth';

const jwt = (h.authConfiguration.current as {
  callbacks: { jwt: (args: never) => Promise<unknown> };
}).callbacks.jwt;

describe('auth JWT database epoch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.select.mockReturnValue({ from: h.from });
    h.from.mockReturnValue({ leftJoin: h.leftJoin });
    h.leftJoin.mockReturnValue({ where: h.where });
    h.where.mockResolvedValue([{
      epoch: 4,
      plan: 'pro',
      trialEndsAt: null,
      isAdmin: false,
    }]);
  });

  it('纪元一致时放行并同步用户数据', async () => {
    const result = await jwt({ token: { id: 'user-1', dbEpoch: 4, plan: 'free' } } as never);
    expect(result).toMatchObject({ dbEpoch: 4, plan: 'pro', isAdmin: false });
    expect(h.select).toHaveBeenCalledTimes(1);
  });

  it('缺少纪元且当前纪元大于零时撤销会话', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await jwt({ token: { id: 'user-1' } } as never);
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith('[auth] legacy session revoked after epoch bump');
    warn.mockRestore();
  });

  it('缺少纪元且当前纪元为零时放行并补零', async () => {
    h.where.mockResolvedValue([{ epoch: 0, plan: 'free', trialEndsAt: null, isAdmin: false }]);
    const result = await jwt({ token: { id: 'user-1' } } as never);
    expect(result).toMatchObject({ dbEpoch: 0, plan: 'free' });
  });

  it('用户行不存在时撤销会话并记录警告', async () => {
    h.where.mockResolvedValue([]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await jwt({ token: { id: 'deleted-user', dbEpoch: 4 } } as never);
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith('[auth] session user missing; revoking session');
    warn.mockRestore();
  });

  it('数据库查询失败时撤销会话', async () => {
    h.where.mockRejectedValue(new Error('db unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await jwt({ token: { id: 'user-1', dbEpoch: 4 } } as never);
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith('[auth] session identity check failed; revoking session');
    warn.mockRestore();
  });
});
