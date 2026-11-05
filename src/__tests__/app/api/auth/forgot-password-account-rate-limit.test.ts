/**
 * 找回密码按账号去重（#696 → #714）：
 * - 原限流键是「IP + 输入地址」，换 +别名 / Gmail 点号写法或换出口 IP 即可绕开；命中账号后再按账号 id 计。
 * - #714：硬性「每小时 3 封」可被攻击者用来让受害者当天收不到信。改为短窗去重——同一账号 5 分钟内
 *   只发 1 封（期间的请求跳过，上一封信里的链接仍有效），另保留宽松的每日上限（50 封）兜底防轰炸。
 * - #714：查库、去重、写令牌、发信全部放到响应之后执行（after），接口在命中 / 未命中 / 去重三种情况下
 *   走同一条同步路径，响应时间不再泄露账号是否存在。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockUserFindMany, mockInsertValues, mockDeleteWhere, mockSendEmail, deferred } = vi.hoisted(() => ({
  mockUserFindMany: vi.fn(),
  mockInsertValues: vi.fn(),
  mockDeleteWhere: vi.fn(),
  mockSendEmail: vi.fn(),
  deferred: [] as Array<() => Promise<void>>,
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  or: (...conds: unknown[]) => ({ op: 'or', conds }),
}));

vi.mock('@/lib/prisma', () => ({
  db: {
    query: { users: { findMany: mockUserFindMany } },
    insert: () => ({ values: mockInsertValues }),
    delete: () => ({ where: mockDeleteWhere }),
  },
  passwordResetTokens: { email: 'prt.email', token: 'prt.token', id: 'prt.id' },
  users: { email: 'users.email', emailNormalized: 'users.emailNormalized', id: 'users.id' },
}));

vi.mock('@/lib/resend', () => ({ sendPasswordResetEmail: mockSendEmail }));
// 响应后任务：测试里先收集，响应返回后再手动执行
vi.mock('@/lib/after-response', () => ({
  runAfterResponse: (task: () => Promise<void>) => {
    deferred.push(task);
  },
}));

const ACCOUNT = { id: 'u-ryan', email: 'ryan.pang@gmail.com', emailNormalized: 'ryanpang@gmail.com' };
const MINUTE = 60_000;

let seq = 0;
/** 每次换一个别名写法 + 一个出口 IP，确保原「IP + 输入地址」那层永远不触发。 */
function nextAlias(): { email: string; ip: string } {
  seq += 1;
  const variants = [
    `ryan.pang+t${seq}@gmail.com`,
    `r.yan.pang+t${seq}@gmail.com`,
    `RyanPang+t${seq}@Gmail.com`,
    `ryanpang+t${seq}@googlemail.com`,
  ];
  return { email: variants[seq % variants.length], ip: `203.0.113.${seq % 250}` };
}

async function flush() {
  while (deferred.length) await deferred.shift()!();
}

async function forgotNoFlush({ email, ip }: { email: string; ip: string }) {
  const { POST } = await import('@/app/api/auth/forgot-password/route');
  const res = await POST(
    new Request('http://cloud.test/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ email }),
    }) as never,
  );
  return { status: res.status, body: await res.json() };
}

async function forgot(arg: { email: string; ip: string }) {
  const r = await forgotNoFlush(arg);
  await flush();
  return r;
}

describe('forgot-password — 按账号短窗去重 + 每日上限（#696 / #714）', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-05T00:00:00Z'));
    seq = 0;
    deferred.length = 0;
    mockUserFindMany.mockReset().mockResolvedValue([ACCOUNT]);
    mockInsertValues.mockReset().mockResolvedValue(undefined);
    mockDeleteWhere.mockReset().mockResolvedValue(undefined);
    mockSendEmail.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('5 分钟内多个别名打同一账号只发 1 封，其余请求同形成功、不发信、不动令牌', async () => {
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await forgot(nextAlias()));

    for (const r of results) expect(r).toEqual({ status: 200, body: { success: true } });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockInsertValues).toHaveBeenCalledTimes(1);
    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0]).toBe(ACCOUNT.email);
  });

  it('去重窗口过后同一小时内可再次发信（不再有每小时 3 封的硬上限）', async () => {
    for (let i = 0; i < 5; i++) {
      await forgot(nextAlias());
      vi.setSystemTime(Date.now() + 5 * MINUTE + 1);
    }
    expect(mockSendEmail).toHaveBeenCalledTimes(5);
  });

  it('攻击者持续请求也挡不住受害者收信：任何时刻最近一封信都不早于 5 分钟前', async () => {
    // 攻击者每分钟打一次，持续 200 分钟（远超原「每小时 3 封」会锁死受害者的量）
    const sentAt: number[] = [];
    mockSendEmail.mockImplementation(() => {
      sentAt.push(Date.now());
      return Promise.resolve();
    });
    for (let m = 0; m < 200; m++) {
      await forgot(nextAlias());
      const last = sentAt[sentAt.length - 1];
      expect(Date.now() - last).toBeLessThanOrEqual(5 * MINUTE);
      vi.setSystemTime(Date.now() + MINUTE);
    }
  });

  it('每日上限 50 封兜底，满一天后恢复', async () => {
    for (let i = 0; i < 55; i++) {
      await forgot(nextAlias());
      vi.setSystemTime(Date.now() + 5 * MINUTE + 1);
    }
    expect(mockSendEmail).toHaveBeenCalledTimes(50);

    vi.setSystemTime(new Date('2026-11-06T00:00:01Z'));
    await forgot(nextAlias());
    expect(mockSendEmail).toHaveBeenCalledTimes(51);
  });

  it('账号之间互不影响：另一个账号照常发信', async () => {
    await forgot(nextAlias());
    await forgot(nextAlias());
    expect(mockSendEmail).toHaveBeenCalledTimes(1);

    mockUserFindMany.mockResolvedValue([{ id: 'u-other', email: 'other@example.com', emailNormalized: 'other@example.com' }]);
    const r = await forgot({ email: 'other@example.com', ip: '198.51.100.7' });
    expect(r).toEqual({ status: 200, body: { success: true } });
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    expect(mockSendEmail.mock.calls[1][0]).toBe('other@example.com');
  });

  it('精确地址与 emailNormalized 同时命中不同账号时，优先精确地址那个', async () => {
    mockUserFindMany.mockResolvedValue([
      { id: 'u-norm', email: 'ryanpang@gmail.com', emailNormalized: 'ryanpang@gmail.com' },
      { id: 'u-exact', email: 'ryan.pang+x@gmail.com', emailNormalized: 'ryanpang@gmail.com' },
    ]);
    await forgot({ email: 'Ryan.Pang+x@gmail.com', ip: '198.51.100.9' });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0]).toBe('ryan.pang+x@gmail.com');
  });

  it('时间侧信道：响应返回前不查库、不发信；命中 / 未命中 / 去重三种情况同步路径一致', async () => {
    const hit = await forgotNoFlush(nextAlias());
    expect(mockUserFindMany).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(deferred).toHaveLength(1);
    await flush();
    expect(mockSendEmail).toHaveBeenCalledTimes(1);

    const dedup = await forgotNoFlush(nextAlias());
    expect(deferred).toHaveLength(1);
    await flush();

    mockUserFindMany.mockResolvedValue([]);
    const unknown = await forgotNoFlush({ email: 'nobody@example.com', ip: '198.51.100.8' });
    expect(deferred).toHaveLength(1);
    await flush();

    expect(hit).toEqual(unknown);
    expect(dedup).toEqual(unknown);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    // 命中与未命中都只查一次库（统一查库路径）
    expect(mockUserFindMany).toHaveBeenCalledTimes(3);
  });
});
