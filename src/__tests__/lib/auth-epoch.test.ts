import { describe, expect, it, vi } from 'vitest';

const { getSettingUncached, authConfiguration } = vi.hoisted(() => ({ getSettingUncached: vi.fn(), authConfiguration: { current: null as unknown } }));
vi.mock('next-auth', () => ({ default: (config: unknown) => { authConfiguration.current = config; return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }; } }));
vi.mock('@/lib/platform-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform-settings')>()),
  getSettingUncached,
}));
vi.mock('@/lib/prisma', () => ({ getDb: vi.fn(), db: {}, users: {} }));

import '@/auth';
import { PLATFORM_SETTING_KEYS } from '@/lib/platform-settings';

describe('auth JWT database epoch', () => {
  const jwt = (authConfiguration.current as { callbacks: { jwt: (args: never) => Promise<unknown> } }).callbacks.jwt;
  it('保留纪元一致的会话', async () => {
    getSettingUncached.mockResolvedValue(4);
    const result = await jwt({ token: { dbEpoch: 4 }, trigger: 'signIn' } as never);
    expect(result).toMatchObject({ dbEpoch: 4 });
  });
  it.each([
    ['纪元落后', async () => getSettingUncached.mockResolvedValue(5)],
    ['读取失败', async () => getSettingUncached.mockRejectedValue(new Error('db unavailable'))],
  ])('%s 时撤销会话', async (_label, setup) => {
    await setup();
    const result = await jwt({ token: { dbEpoch: 4 }, trigger: 'signIn' } as never);
    expect(result).toBeNull();
    expect(getSettingUncached).toHaveBeenCalledWith(PLATFORM_SETTING_KEYS.AUTH_DB_EPOCH);
  });
});
