/**
 * 找回密码按账号再限流一层（#696）：原限流键是「IP + 输入地址」，换 +别名 / Gmail 点号写法
 * （都经 emailNormalized 命中同一账号）或换出口 IP 即可绕开，对同一真实邮箱批量发重置信。
 * 命中账号后按账号 id 再计数（每小时 3 封、每天 10 封）；超限仍返回同形 200，且不发信、不动令牌，
 * 不给账号枚举留差异。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockUserFindFirst, mockInsertValues, mockDeleteWhere, mockSendEmail } = vi.hoisted(() => ({
  mockUserFindFirst: vi.fn(),
  mockInsertValues: vi.fn(),
  mockDeleteWhere: vi.fn(),
  mockSendEmail: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
}));

vi.mock('@/lib/prisma', () => ({
  db: {
    query: { users: { findFirst: mockUserFindFirst } },
    insert: () => ({ values: mockInsertValues }),
    delete: () => ({ where: mockDeleteWhere }),
  },
  passwordResetTokens: { email: 'prt.email', token: 'prt.token', id: 'prt.id' },
  users: { email: 'users.email', emailNormalized: 'users.emailNormalized', id: 'users.id' },
}));

vi.mock('@/lib/resend', () => ({ sendPasswordResetEmail: mockSendEmail }));

const ACCOUNT = { id: 'u-ryan', email: 'ryan.pang@gmail.com' };
const HOUR = 3_600_000;

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

async function forgot({ email, ip }: { email: string; ip: string }) {
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

describe('forgot-password — 按账号限流（#696）', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-05T00:00:00Z'));
    seq = 0;
    // 任何别名都经 emailNormalized 命中同一账号；精确地址查不到
    mockUserFindFirst.mockReset().mockImplementation((arg: { where: { col: string } }) =>
      Promise.resolve(arg.where.col === 'users.emailNormalized' ? ACCOUNT : undefined),
    );
    mockInsertValues.mockReset().mockResolvedValue(undefined);
    mockDeleteWhere.mockReset().mockResolvedValue(undefined);
    mockSendEmail.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('多个别名打同一账号：每小时只发 3 封，第 4 封起仍回同形成功但不发信、不动令牌', async () => {
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await forgot(nextAlias()));

    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ success: true });
    }
    expect(mockSendEmail).toHaveBeenCalledTimes(3);
    expect(mockInsertValues).toHaveBeenCalledTimes(3);
    expect(mockDeleteWhere).toHaveBeenCalledTimes(3);
    // 信始终发到账号登记的地址
    for (const call of mockSendEmail.mock.calls) expect(call[0]).toBe(ACCOUNT.email);
  });

  it('跨小时累计：每天最多 10 封，满额后下一小时也不再发', async () => {
    for (let hour = 0; hour < 5; hour++) {
      for (let i = 0; i < 3; i++) {
        const r = await forgot(nextAlias());
        expect(r).toEqual({ status: 200, body: { success: true } });
      }
      vi.setSystemTime(Date.now() + HOUR + 1);
    }
    expect(mockSendEmail).toHaveBeenCalledTimes(10);

    // 满一天后恢复
    vi.setSystemTime(new Date('2026-11-06T00:00:01Z'));
    await forgot(nextAlias());
    expect(mockSendEmail).toHaveBeenCalledTimes(11);
  });

  it('一小时后小时额度恢复', async () => {
    for (let i = 0; i < 4; i++) await forgot(nextAlias());
    expect(mockSendEmail).toHaveBeenCalledTimes(3);
    vi.setSystemTime(Date.now() + HOUR + 1);
    await forgot(nextAlias());
    expect(mockSendEmail).toHaveBeenCalledTimes(4);
  });

  it('账号限流互不影响：另一个账号照常发信', async () => {
    for (let i = 0; i < 4; i++) await forgot(nextAlias());
    expect(mockSendEmail).toHaveBeenCalledTimes(3);

    mockUserFindFirst.mockImplementation((arg: { where: { col: string } }) =>
      Promise.resolve(arg.where.col === 'users.email' ? { id: 'u-other', email: 'other@example.com' } : undefined),
    );
    const r = await forgot({ email: 'other@example.com', ip: '198.51.100.7' });
    expect(r).toEqual({ status: 200, body: { success: true } });
    expect(mockSendEmail).toHaveBeenCalledTimes(4);
    expect(mockSendEmail.mock.calls[3][0]).toBe('other@example.com');
  });

  it('账号超限与查无此号的响应完全一致（无枚举差异）', async () => {
    for (let i = 0; i < 3; i++) await forgot(nextAlias());
    const limited = await forgot(nextAlias());

    mockUserFindFirst.mockResolvedValue(undefined);
    const unknown = await forgot({ email: 'nobody@example.com', ip: '198.51.100.8' });

    expect(limited).toEqual(unknown);
  });
});
