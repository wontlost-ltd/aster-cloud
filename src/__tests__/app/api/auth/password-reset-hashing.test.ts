import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';

/**
 * Password-reset tokens must be hashed at rest (audit #168):
 *  (a) forgot-password persists sha256(token), not the raw token; the raw
 *      token only appears in the emailed link.
 *  (b) reset-password looks the row up by sha256(token); a raw-token lookup
 *      never matches the stored hash.
 */

function sha256(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

const {
  mockUserFindFirst,
  mockResetFindFirst,
  mockInsertValues,
  mockDeleteWhere,
  mockUpdateWhere,
  mockSendEmail,
  mockHashPassword,
} = vi.hoisted(() => ({
  mockUserFindFirst: vi.fn(),
  mockResetFindFirst: vi.fn(),
  mockInsertValues: vi.fn(),
  mockDeleteWhere: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockSendEmail: vi.fn(),
  mockHashPassword: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
}));

vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      users: { findFirst: mockUserFindFirst },
      passwordResetTokens: { findFirst: mockResetFindFirst },
    },
    insert: () => ({ values: mockInsertValues }),
    delete: () => ({ where: mockDeleteWhere }),
    update: () => ({ set: () => ({ where: mockUpdateWhere }) }),
  },
  passwordResetTokens: { email: 'prt.email', token: 'prt.token', id: 'prt.id' },
  users: { email: 'users.email', emailNormalized: 'users.emailNormalized', id: 'users.id' },
}));

vi.mock('@/lib/resend', () => ({ sendPasswordResetEmail: mockSendEmail }));
vi.mock('@/lib/auth', () => ({ hashPassword: mockHashPassword }));

const originalKey = process.env.ASTER_PLAN_GATE_HMAC_KEY;

function reset() {
  mockUserFindFirst.mockReset();
  mockResetFindFirst.mockReset();
  mockInsertValues.mockReset().mockResolvedValue(undefined);
  mockDeleteWhere.mockReset().mockResolvedValue(undefined);
  mockUpdateWhere.mockReset().mockResolvedValue(undefined);
  mockSendEmail.mockReset().mockResolvedValue(undefined);
  mockHashPassword.mockReset().mockResolvedValue('new-hash');
}

describe('forgot-password — stores hashed token, emails raw (audit #168)', () => {
  beforeEach(() => { vi.resetModules(); reset(); });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.ASTER_PLAN_GATE_HMAC_KEY;
    else process.env.ASTER_PLAN_GATE_HMAC_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it('persists sha256(token) and never the raw token', async () => {
    mockUserFindFirst.mockResolvedValue({ id: 'u1', email: 'a@b.com' });
    const { POST } = await import('@/app/api/auth/forgot-password/route');
    const req = new Request('http://cloud.test/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.com' }),
    });
    // NextRequest is compatible with Request for this handler.
    const res = await POST(req as never);
    expect(res.status).toBe(200);

    // Raw token was emailed.
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const emailedToken = mockSendEmail.mock.calls[0][1] as string;
    expect(emailedToken).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes as hex

    // Stored token is the hash of the emailed raw token, not the raw value.
    expect(mockInsertValues).toHaveBeenCalledTimes(1);
    const stored = mockInsertValues.mock.calls[0][0].token as string;
    expect(stored).toBe(sha256(emailedToken));
    expect(stored).not.toBe(emailedToken);
  });
});

describe('forgot-password — 按同一邮箱找账号，发到账号登记的地址（#682）', () => {
  beforeEach(() => { vi.resetModules(); reset(); });

  const forgot = async (email: string) => {
    const { POST } = await import('@/app/api/auth/forgot-password/route');
    return POST(new Request('http://cloud.test/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    }) as never);
  };

  it('精确地址找不到时按 emailNormalized 找到另一个 +别名的账号，信与令牌都用账号地址', async () => {
    mockUserFindFirst.mockImplementation((arg: { where: { col: string; val: string } }) =>
      Promise.resolve(
        arg.where.col === 'users.emailNormalized' && arg.where.val === 'ryan.pang@wontlost.com'
          ? { id: 'u1', email: 'ryan.pang+adr0051-retest@wontlost.com' }
          : undefined,
      ),
    );
    const res = await forgot('Ryan.Pang+adr0051-member1@wontlost.com');
    expect(res.status).toBe(200);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0]).toBe('ryan.pang+adr0051-retest@wontlost.com');
    expect(mockInsertValues.mock.calls[0][0].email).toBe('ryan.pang+adr0051-retest@wontlost.com');
    expect(mockDeleteWhere).toHaveBeenCalledWith({ op: 'eq', col: 'prt.email', val: 'ryan.pang+adr0051-retest@wontlost.com' });
  });

  it('精确地址命中时不再按别名查', async () => {
    mockUserFindFirst.mockResolvedValue({ id: 'u1', email: 'a@b.com' });
    await forgot('a@b.com');
    expect(mockUserFindFirst).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0]).toBe('a@b.com');
  });

  it('同一邮箱也找不到：仍返回 200，不发信（防枚举不变）', async () => {
    mockUserFindFirst.mockResolvedValue(undefined);
    const res = await forgot('nobody+x@example.com');
    expect(res.status).toBe(200);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockInsertValues).not.toHaveBeenCalled();
  });
});

describe('reset-password — lookup by hash, raw lookup fails (audit #168)', () => {
  beforeEach(() => { vi.resetModules(); reset(); });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.ASTER_PLAN_GATE_HMAC_KEY;
    else process.env.ASTER_PLAN_GATE_HMAC_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it('queries PasswordResetToken by sha256(token), not the raw token', async () => {
    const rawToken = 'a'.repeat(64);
    // DB holds only the hash; findFirst returns a row iff queried by that hash.
    mockResetFindFirst.mockImplementation((arg: { where: { val: string } }) =>
      Promise.resolve(
        arg.where.val === sha256(rawToken)
          ? { id: 't1', email: 'a@b.com', token: sha256(rawToken), expires: new Date(Date.now() + 3_600_000) }
          : undefined,
      ),
    );
    mockUserFindFirst.mockResolvedValue({ id: 'u1', email: 'a@b.com' });

    const { POST } = await import('@/app/api/auth/reset-password/route');
    const req = new Request('http://cloud.test/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: rawToken, password: 'longenough123' }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(200);

    // The lookup used the hash, never the raw token.
    expect(mockResetFindFirst).toHaveBeenCalledTimes(1);
    const queriedVal = mockResetFindFirst.mock.calls[0][0].where.val as string;
    expect(queriedVal).toBe(sha256(rawToken));
    expect(queriedVal).not.toBe(rawToken);
  });

  it('a raw-token value equal to what a plaintext store would hold does not match', async () => {
    const rawToken = 'b'.repeat(64);
    // Simulate a DB that (wrongly) stored the RAW token: a hash-based lookup
    // must miss it, proving we no longer look up by raw value.
    mockResetFindFirst.mockImplementation((arg: { where: { val: string } }) =>
      Promise.resolve(arg.where.val === rawToken ? { id: 't1' } : undefined),
    );

    const { POST } = await import('@/app/api/auth/reset-password/route');
    const req = new Request('http://cloud.test/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: rawToken, password: 'longenough123' }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400); // invalid/expired — hash lookup missed the raw row
    const queriedVal = mockResetFindFirst.mock.calls[0][0].where.val as string;
    expect(queriedVal).toBe(sha256(rawToken));
  });
});
