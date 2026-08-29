import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 邮箱+密码注册（此前完全缺失：登录页支持 credentials、`authorize()` 按
 * passwordHash 校验，但没有任何**自助**路径能创建带密码的账号——
 * 运维预置路径 db-bootstrap 一直存在）。
 *
 * 本测试锁住四条关键性质：
 *  (a) 邮箱枚举防护——已存在时返回与成功**同形**的 200，不泄露占用情况
 *  (b) emailNormalized 也参与占用检查（否则 a.b+x@gmail.com 能绕开 ab@gmail.com）
 *  (c) 走适配器 createUser——注册风控（IP 聚类 / hard-purge / 可疑邮箱）不被绕过
 *  (d) on-prem（CAN_SIGNUP=false）下 API 也关闭，而非只关页面
 */

const {
  mockUserFindFirst,
  mockUpdateSet,
  mockUpdateWhere,
  mockCreateUser,
  mockHashPassword,
  mockRateLimit,
  mockNormalizeEmail,
  mockCanSignup,
  mockSignupHardLimit,
  mockRecordAttempt,
  mockIsDisposable,
} = vi.hoisted(() => ({
  mockUserFindFirst: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockCreateUser: vi.fn(),
  mockHashPassword: vi.fn(),
  mockRateLimit: vi.fn(),
  mockNormalizeEmail: vi.fn(),
  mockCanSignup: { value: true },
  mockSignupHardLimit: vi.fn(),
  mockRecordAttempt: vi.fn(),
  mockIsDisposable: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...parts: unknown[]) => ({ op: 'and', parts }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
}));

vi.mock('@/lib/prisma', () => ({
  db: {
    query: { users: { findFirst: mockUserFindFirst } },
    // ★set 必须是捕获参数的 spy：写成 `set: () => (...)` 会丢弃入参，
    //   导致「passwordHash 写进去的是什么值」在物理上无法断言——
    //   明文存储 / 算了哈希不写库 / 写恒定字符串三种变异都能全绿。
    update: () => ({
      set: (v: unknown) => {
        mockUpdateSet(v);
        return { where: mockUpdateWhere };
      },
    }),
  },
  users: {
    id: 'users.id',
    email: 'users.email',
    emailNormalized: 'users.emailNormalized',
    signupIpHash: 'users.signupIpHash',
  },
}));

vi.mock('@/auth', () => ({ hashPassword: mockHashPassword }));
vi.mock('@/lib/email-normalize', () => ({ normalizeEmail: mockNormalizeEmail }));
vi.mock('@/lib/signup-rate-limit', () => ({
  hashIp: (ip: string) => `h(${ip})`,
  checkSignupRateLimit: mockSignupHardLimit,
  recordSignupAttempt: mockRecordAttempt,
}));
vi.mock('@/lib/email-disposable', () => ({ isDisposableEmail: mockIsDisposable }));
vi.mock('@/lib/rate-limit-distributed', () => ({
  checkRateLimitDistributed: mockRateLimit,
}));
vi.mock('@/db/adapter', () => ({
  DrizzleAdapter: () => ({ createUser: mockCreateUser }),
}));
vi.mock('@/lib/deployment-mode', () => ({
  get CAN_SIGNUP() {
    return mockCanSignup.value;
  },
}));

function reset() {
  mockUserFindFirst.mockReset().mockResolvedValue(undefined);
  mockUpdateSet.mockReset();
  mockUpdateWhere.mockReset().mockResolvedValue(undefined);
  mockCreateUser.mockReset().mockResolvedValue({ id: 'new-user', email: 'a@b.c' });
  mockHashPassword.mockReset().mockResolvedValue('hashed');
  mockRateLimit.mockReset().mockResolvedValue({ allowed: true });
  mockNormalizeEmail.mockReset().mockImplementation((e: string) => e.replace(/\./g, ''));
  mockCanSignup.value = true;
  mockSignupHardLimit.mockReset().mockResolvedValue(true);
  mockRecordAttempt.mockReset().mockResolvedValue(undefined);
  mockIsDisposable.mockReset().mockReturnValue(false);
}

const post = (body: unknown) =>
  new Request('http://x/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const GOOD = { email: 'new@example.com', password: 'longenough1' };

describe('signup — 建号、防枚举、不绕风控', () => {
  beforeEach(() => {
    vi.resetModules();
    reset();
  });

  it('新邮箱：走适配器 createUser，并单独写入 passwordHash', async () => {
    const { POST } = await import('@/app/api/auth/signup/route');
    const res = await POST(post(GOOD) as never);
    expect(res.status).toBe(200);

    expect(mockCreateUser).toHaveBeenCalledTimes(1);
    const arg = mockCreateUser.mock.calls[0][0] as {
      email: string;
      emailVerified: unknown;
    };
    expect(arg.email).toBe('new@example.com');
    // ★不得预置已验证——否则绕过邮箱验证闸门直接解锁 AI
    expect(arg.emailVerified).toBeNull();

    // ★不能只断言「hashPassword 被调用过」——那让「明文落库」「算了哈希
    //   丢弃不写」「写恒定字符串」三种改动全部逃逸（假绿猎手实测 M9/M11/M27）。
    //   必须断言**写进库的值**来自哈希、且明文绝不出现。
    expect(mockHashPassword).toHaveBeenCalledWith('longenough1');
    const written = mockUpdateSet.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const pwWrite = written.find((w) => 'passwordHash' in w);
    expect(pwWrite, 'passwordHash 从未写入库').toBeTruthy();
    expect(pwWrite!.passwordHash).toBe('hashed');
    const allValues = written.flatMap((w) => Object.values(w));
    expect(allValues).not.toContain('longenough1'); // 明文绝不落库
  });

  it('★响应形状：成功与「已占用」逐字段相同（同形是关系性质，不能只测一侧）', async () => {
    const { POST } = await import('@/app/api/auth/signup/route');
    const bodyNew = await (await POST(post(GOOD) as never)).json();

    reset();
    mockUserFindFirst.mockResolvedValue({ id: 'existing' });
    const { POST: POST2 } = await import('@/app/api/auth/signup/route');
    const bodyDup = await (await POST2(post(GOOD) as never)).json();

    expect(bodyDup).toEqual(bodyNew);
  });

  it('★一次性邮箱被拒，且返回同形 200（黑名单不可被当成探测接口）', async () => {
    mockIsDisposable.mockReturnValue(true);
    const { POST } = await import('@/app/api/auth/signup/route');
    const res = await POST(post({ email: 'x@mailinator.com', password: 'longenough1' }) as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockCreateUser, '一次性邮箱不得建号').not.toHaveBeenCalled();
    expect(mockRecordAttempt).toHaveBeenCalledWith(expect.anything(), false);
  });

  it('★同 IP 24h 硬闸生效（与按小时的分布式限流是两道闸）', async () => {
    mockSignupHardLimit.mockResolvedValue(false);
    const { POST } = await import('@/app/api/auth/signup/route');
    const res = await POST(post(GOOD) as never);

    expect(res.status).toBe(429);
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(mockRecordAttempt).toHaveBeenCalledWith(expect.anything(), false);
  });

  it('★成功注册要记账，否则硬闸永远数不满', async () => {
    const { POST } = await import('@/app/api/auth/signup/route');
    await POST(post(GOOD) as never);
    expect(mockRecordAttempt).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('★已存在的邮箱返回与成功同形的 200（不泄露占用）', async () => {
    mockUserFindFirst.mockResolvedValue({ id: 'existing' });
    const { POST } = await import('@/app/api/auth/signup/route');
    const res = await POST(post(GOOD) as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // 关键：不建号、不写密码
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(mockHashPassword).not.toHaveBeenCalled();
  });

  it('★emailNormalized 撞号也被拦（a.b@x 与 ab@x 视为同一账号）', async () => {
    // 精确 email 查不到，但 normalized 查得到
    mockUserFindFirst
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: 'normalized-dup' });

    const { POST } = await import('@/app/api/auth/signup/route');
    const res = await POST(post({ email: 'a.b@example.com', password: 'longenough1' }) as never);

    expect(res.status).toBe(200);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it('★on-prem（CAN_SIGNUP=false）关闭 API，不只是关页面', async () => {
    mockCanSignup.value = false;
    const { POST } = await import('@/app/api/auth/signup/route');
    const res = await POST(post(GOOD) as never);

    expect(res.status).toBe(404);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it('密码短于 8 位被拒且不建号', async () => {
    const { POST } = await import('@/app/api/auth/signup/route');
    const res = await POST(post({ email: 'a@b.c', password: 'short' }) as never);
    expect(res.status).toBe(400);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it('非法邮箱被拒且不建号', async () => {
    const { POST } = await import('@/app/api/auth/signup/route');
    for (const email of ['not-an-email', 'a@b', '', 'a b@c.d']) {
      const res = await POST(post({ email, password: 'longenough1' }) as never);
      expect(res.status, `email=${email}`).toBe(400);
    }
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it('限流命中返回 429 且不建号', async () => {
    mockRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    const { POST } = await import('@/app/api/auth/signup/route');
    const res = await POST(post(GOOD) as never);
    expect(res.status).toBe(429);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });
});
