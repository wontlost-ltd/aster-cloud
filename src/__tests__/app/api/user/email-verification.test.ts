import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

/**
 * 邮箱验证流程（补齐此前完全缺失的一环）。
 *
 * 此前 `ai-quota.ts` 的 L0.5 闸门要求 Free 档 `emailVerified` 才解锁 AI，
 * 但**没有任何面向普通用户的路径写入该字段**（只有 seed 脚本、db-bootstrap
 * 的运维预置 admin、OAuth 透传），也没有发信/确认接口——凭账号密码
 * 注册的 Free 用户被永久锁死。本测试锁住新流程的三条关键性质：
 *
 *  (a) 发信端存 sha256(token)，原始 token 只出现在邮件里（同 forgot-password，审计 #168）
 *  (b) 发信端邮箱**取自会话**而非请求体——否则是任意地址发信喷口
 *  (c) 确认端「先删后写」，同一 token 不可复用（并发双击只有一次生效）
 */

function sha256(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

const {
  mockGetSession,
  mockUserFindFirst,
  mockTokenFindFirst,
  mockInsertValues,
  mockUpdateSet,
  mockUpdateWhere,
  mockDeleteWhere,
  mockDeleteReturning,
  mockUpdateReturning,
  mockSendEmail,
  mockRateLimit,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockUserFindFirst: vi.fn(),
  mockTokenFindFirst: vi.fn(),
  mockInsertValues: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockDeleteWhere: vi.fn(),
  mockDeleteReturning: vi.fn(),
  mockUpdateReturning: vi.fn(),
  mockSendEmail: vi.fn(),
  mockRateLimit: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...parts: unknown[]) => ({ op: 'and', parts }),
}));

vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      users: { findFirst: mockUserFindFirst },
      verificationTokens: { findFirst: mockTokenFindFirst },
    },
    insert: () => ({ values: mockInsertValues }),
    // delete().where() 既可能被 await（发信端作废旧 token），
    // 也可能继续 .returning()（确认端先删后写）。故 where 返回一个
    // 既是 thenable、又带 returning 的对象。
    delete: () => ({
      where: (...args: unknown[]) => {
        mockDeleteWhere(...args);
        return {
          returning: mockDeleteReturning,
          then: (r: (v: unknown) => unknown) => Promise.resolve(undefined).then(r),
        };
      },
    }),
    // ★where 必须捕获参数：写成 `where: () => (...)` 会丢弃更新目标，
    //   导致「改成全表更新（所有用户被标已验证）」这种变异全绿（M26）。
    update: () => ({
      set: (v: unknown) => {
        mockUpdateSet(v);
        return {
          where: (w: unknown) => {
            mockUpdateWhere(w);
            return { returning: mockUpdateReturning };
          },
        };
      },
    }),
  },
  users: { id: 'users.id', email: 'users.email' },
  verificationTokens: {
    identifier: 'vt.identifier',
    token: 'vt.token',
    expires: 'vt.expires',
  },
}));

vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }));
vi.mock('@/lib/resend', () => ({ sendVerificationEmail: mockSendEmail }));
vi.mock('@/lib/rate-limit-distributed', () => ({
  checkRateLimitDistributed: mockRateLimit,
}));

function reset() {
  mockGetSession.mockReset();
  mockUserFindFirst.mockReset();
  mockTokenFindFirst.mockReset();
  mockInsertValues.mockReset().mockResolvedValue(undefined);
  mockUpdateSet.mockReset();
  mockUpdateWhere.mockReset();
  mockDeleteWhere.mockReset();
  mockDeleteReturning.mockReset().mockResolvedValue([{ token: 'x' }]);
  mockUpdateReturning.mockReset().mockResolvedValue([{ id: 'u1' }]);
  mockSendEmail.mockReset().mockResolvedValue(undefined);
  mockRateLimit.mockReset().mockResolvedValue({ allowed: true });
}

const post = (url: string, body?: unknown) =>
  new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('send-verification — 存哈希、发原文、邮箱取自会话', () => {
  beforeEach(() => {
    vi.resetModules();
    reset();
  });

  it('库里存 sha256(token)，邮件里发原始 token', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'u1' } });
    mockUserFindFirst.mockResolvedValue({
      id: 'u1',
      email: 'User@Example.com',
      emailVerified: null,
    });

    const { POST } = await import('@/app/api/user/send-verification/route');
    const res = await POST(post('http://x/api/user/send-verification') as never);
    expect(res.status).toBe(200);

    expect(mockInsertValues).toHaveBeenCalledTimes(1);
    const stored = mockInsertValues.mock.calls[0][0] as {
      identifier: string;
      token: string;
    };
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const [emailedTo, rawToken] = mockSendEmail.mock.calls[0] as [string, string];

    // 原始 token 绝不落库
    expect(stored.token).not.toBe(rawToken);
    expect(stored.token).toBe(sha256(rawToken));
    // 邮箱统一小写后既用作 identifier 也用作收件人
    expect(stored.identifier).toBe('email-verify:user@example.com');
    expect(emailedTo).toBe('user@example.com');

    // ★token 熵：退化成 'tok'+Date.now() 这类可预测值会让他人链接可被枚举。
    expect(rawToken).toMatch(/^[0-9a-f]{64}$/);

    // ★有效期**上界**是关键：只测下界的话「24h 改成 100 年」会全绿。
    const ttl = (stored as unknown as { expires: Date }).expires.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(23 * 3600_000);
    expect(ttl).toBeLessThanOrEqual(24 * 3600_000);

    // ★「一次只允许一条有效链接」：必须在写新 token **之前**作废旧的，
    //   否则旧链接永久有效、被窃取窗口无限扩大。
    expect(mockDeleteWhere).toHaveBeenCalledWith({
      op: 'eq', col: 'vt.identifier', val: 'email-verify:user@example.com',
    });
    expect(mockDeleteWhere.mock.invocationCallOrder[0])
      .toBeLessThan(mockInsertValues.mock.invocationCallOrder[0]);
  });

  it('★账号无邮箱时报错且不发信', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'u1' } });
    mockUserFindFirst.mockResolvedValue({ id: 'u1', email: null, emailVerified: null });

    const { POST } = await import('@/app/api/user/send-verification/route');
    const res = await POST(post('http://x/api/user/send-verification') as never);
    expect(res.status).toBe(400);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('★两次发信的 token 不同（不可预测）', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'u1' } });
    mockUserFindFirst.mockResolvedValue({ id: 'u1', email: 'a@b.c', emailVerified: null });

    const { POST } = await import('@/app/api/user/send-verification/route');
    await POST(post('http://x/api/user/send-verification') as never);
    await POST(post('http://x/api/user/send-verification') as never);

    const [t1, t2] = mockSendEmail.mock.calls.map((c) => c[1] as string);
    expect(t1).not.toBe(t2);
  });

  it('★发信失败必须响亮（502）并回滚刚写入的 token', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'u1' } });
    mockUserFindFirst.mockResolvedValue({ id: 'u1', email: 'a@b.c', emailVerified: null });
    mockSendEmail.mockRejectedValue(new Error('RESEND_SEND_REJECTED: validation_error'));

    const { POST } = await import('@/app/api/user/send-verification/route');
    const res = await POST(post('http://x/api/user/send-verification') as never);

    // 吞掉失败返回 {ok:true} 会让用户等一封永不到来的信，且旧 token 已被作废
    expect(res.status).toBe(502);
    // 回滚：insert 之后还要再删一次
    expect(mockDeleteWhere.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('★邮箱取自会话，请求体里的 email 被忽略（不是任意地址发信喷口）', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'u1' } });
    mockUserFindFirst.mockResolvedValue({
      id: 'u1',
      email: 'owner@example.com',
      emailVerified: null,
    });

    const { POST } = await import('@/app/api/user/send-verification/route');
    await POST(post('http://x/api/user/send-verification', {
      email: 'attacker@evil.test',
    }) as never);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0]).toBe('owner@example.com');
  });

  it('未登录返回 401 且不发信', async () => {
    mockGetSession.mockResolvedValue(null);
    const { POST } = await import('@/app/api/user/send-verification/route');
    const res = await POST(post('http://x/api/user/send-verification') as never);
    expect(res.status).toBe(401);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('已验证的账号不重复发信', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'u1' } });
    mockUserFindFirst.mockResolvedValue({
      id: 'u1',
      email: 'a@b.c',
      emailVerified: new Date(),
    });

    const { POST } = await import('@/app/api/user/send-verification/route');
    const res = await POST(post('http://x/api/user/send-verification') as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ alreadyVerified: true });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('限流命中返回 429 且不发信', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'u1' } });
    mockRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });

    const { POST } = await import('@/app/api/user/send-verification/route');
    const res = await POST(post('http://x/api/user/send-verification') as never);
    expect(res.status).toBe(429);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

describe('verify-email — 按哈希查、先删后写、不可复用', () => {
  beforeEach(() => {
    vi.resetModules();
    reset();
  });

  it('按 sha256(token) 查库（原始 token 查不到）', async () => {
    const raw = 'deadbeef';
    mockTokenFindFirst.mockResolvedValue({
      identifier: 'email-verify:a@b.c',
      token: sha256(raw),
      expires: new Date(Date.now() + 3600_000),
    });

    const { POST } = await import('@/app/api/user/verify-email/route');
    const res = await POST(post('http://x/api/user/verify-email', { token: raw }) as never);
    expect(res.status).toBe(200);

    const lookup = mockTokenFindFirst.mock.calls[0][0] as { where: { val: string } };
    expect(lookup.where.val).toBe(sha256(raw));
    expect(lookup.where.val).not.toBe(raw);
  });

  it('成功时把 emailVerified 置为时间戳', async () => {
    const raw = 'abc123';
    mockTokenFindFirst.mockResolvedValue({
      identifier: 'email-verify:a@b.c',
      token: sha256(raw),
      expires: new Date(Date.now() + 3600_000),
    });

    const { POST } = await import('@/app/api/user/verify-email/route');
    await POST(post('http://x/api/user/verify-email', { token: raw }) as never);
    expect(mockUpdateReturning).toHaveBeenCalledTimes(1);

    // ★必须断言**更新了谁**：只验「走到了 update」的话，把 where 改成
    //   全表更新（所有用户被标已验证 → 全站绕过 AI 闸门）会全绿。
    expect(mockUpdateWhere).toHaveBeenCalledWith({
      op: 'eq', col: 'users.email', val: 'a@b.c',
    });
    // 且写入的确实是 emailVerified 时间戳
    const setArg = mockUpdateSet.mock.calls[0][0] as { emailVerified: unknown };
    expect(setArg.emailVerified).toBeInstanceOf(Date);
  });

  it('★限流命中返回 429，且在查库之前短路', async () => {
    mockRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });
    const { POST } = await import('@/app/api/user/verify-email/route');
    const res = await POST(post('http://x/api/user/verify-email', { token: 'x' }) as never);

    expect(res.status).toBe(429);
    expect(mockTokenFindFirst, '限流必须早于查库').not.toHaveBeenCalled();
  });

  it('★magic-link 的裸 email identifier 被拒，且不消费该 token', async () => {
    const raw = 'magiclink';
    // Auth.js 的 createVerificationToken 存的是裸 email，无 email-verify: 前缀
    mockTokenFindFirst.mockResolvedValue({
      identifier: 'a@b.c',
      token: sha256(raw),
      expires: new Date(Date.now() + 3600_000),
    });

    const { POST } = await import('@/app/api/user/verify-email/route');
    const res = await POST(post('http://x/api/user/verify-email', { token: raw }) as never);

    expect(res.status).toBe(400);
    // 关键：不能删掉别人的登录魔链，也不能标记已验证
    expect(mockDeleteWhere, '不得消费 magic-link token').not.toHaveBeenCalled();
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it('★并发双击：删到 0 行的那次不写 emailVerified', async () => {
    const raw = 'abc123';
    mockTokenFindFirst.mockResolvedValue({
      identifier: 'email-verify:a@b.c',
      token: sha256(raw),
      expires: new Date(Date.now() + 3600_000),
    });
    // 模拟另一并发请求已先删掉该行
    mockDeleteReturning.mockResolvedValue([]);

    const { POST } = await import('@/app/api/user/verify-email/route');
    const res = await POST(post('http://x/api/user/verify-email', { token: raw }) as never);
    expect(res.status).toBe(400);
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it('过期 token 被拒绝且不写 emailVerified', async () => {
    const raw = 'expired';
    mockTokenFindFirst.mockResolvedValue({
      identifier: 'email-verify:a@b.c',
      token: sha256(raw),
      expires: new Date(Date.now() - 1000),
    });

    const { POST } = await import('@/app/api/user/verify-email/route');
    const res = await POST(post('http://x/api/user/verify-email', { token: raw }) as never);
    expect(res.status).toBe(400);
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it('未知 token 被拒绝', async () => {
    mockTokenFindFirst.mockResolvedValue(undefined);
    const { POST } = await import('@/app/api/user/verify-email/route');
    const res = await POST(post('http://x/api/user/verify-email', { token: 'nope' }) as never);
    expect(res.status).toBe(400);
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it('★token 有效但该邮箱已不存在（改邮箱/销号）不算成功', async () => {
    const raw = 'orphan';
    mockTokenFindFirst.mockResolvedValue({
      identifier: 'email-verify:gone@b.c',
      token: sha256(raw),
      expires: new Date(Date.now() + 3600_000),
    });
    mockUpdateReturning.mockResolvedValue([]); // 0 行被更新

    const { POST } = await import('@/app/api/user/verify-email/route');
    const res = await POST(post('http://x/api/user/verify-email', { token: raw }) as never);
    expect(res.status).toBe(400);
  });
});
