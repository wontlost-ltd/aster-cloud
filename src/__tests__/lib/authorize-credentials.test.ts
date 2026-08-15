// Credentials 登录编排的**行为**测试（issue #400）。
//
// ## 为什么这个文件必须存在
//
// 独立审查（假绿猎手）实测：把 `if (!verdict.ok)` 改成 `if (false && !verdict.ok)`
// ——即**二次验证被完全关闭**——32 条测试全绿。同样绿的还有：
// `rememberDevice=true` 绕过 2FA、限流变成空操作、空码不再触发第二屏。
//
// 根因是**结构上不可测**：authorize 曾是 NextAuth 配置里的内联闭包，
// 没有任何测试能调用它。既有的 auth-session-2fa-scope.test.ts 只能断言
// **源码文本**，而文本对"标记全在、行为全没了"的变异完全无能。
//
// 抽成可注入依赖的函数后，这里断言的是**控制流本身**。

import { describe, it, expect, vi } from 'vitest';

import {
  authorizeCredentials,
  type AuthorizeDeps,
} from '@/lib/auth/authorize-credentials';

const USER = {
  id: 'u1',
  email: 'a@example.com',
  name: 'A',
  image: null,
  passwordHash: 'hash',
};

function deps(over: Partial<AuthorizeDeps> = {}): AuthorizeDeps {
  return {
    ensureSchema: vi.fn(async () => {}),
    checkRateLimit: vi.fn(async () => ({ allowed: true })),
    checkAccountLockout: vi.fn(async () => ({ locked: false })),
    recordFailedAttempt: vi.fn(async () => ({ nowLocked: false })),
    resetFailedAttempts: vi.fn(async () => {}),
    verifyPassword: vi.fn(async () => true),
    findUserByEmail: vi.fn(async () => USER),
    isTrustedDevice: vi.fn(async () => false),
    hasActiveCode: vi.fn(async () => false),
    issueCode: vi.fn(async () => ({ ok: true as const, code: '123456' })),
    sendCodeEmail: vi.fn(async () => {}),
    verifyCode: vi.fn(async () => ({ ok: true as const })),
    ...over,
  };
}

const creds = (o: Record<string, unknown> = {}) => ({
  email: 'a@example.com',
  password: 'pw',
  ...o,
});

describe('authorize 编排行为（issue #400）', () => {
  it('★空验证码 → 抛 TWO_FACTOR_REQUIRED，绝不返回 user', async () => {
    // 变异 N13/M20 的守卫：这条一红，说明 2FA 第一屏被跳过了。
    const d = deps();
    await expect(authorizeCredentials(creds(), d)).rejects.toThrow(
      'TWO_FACTOR_REQUIRED',
    );
    expect(d.sendCodeEmail).toHaveBeenCalledOnce();
  });

  it('★验证码错 → 抛错且**不返回 user**（M20：结果被丢弃）', async () => {
    // 审查实测：把 `if (!verdict.ok)` 改成 `if (false && ...)` 时
    // 32 条测试全绿。这条就是补上的那道门。
    const d = deps({
      verifyCode: vi.fn(async () => ({ ok: false as const, reason: 'MISMATCH' as const })),
    });
    await expect(
      authorizeCredentials(creds({ twoFactorCode: '000000' }), d),
    ).rejects.toThrow(/TWO_FACTOR_MISMATCH/);
  });

  it('验证码对 → 返回 user', async () => {
    const d = deps();
    const u = await authorizeCredentials(creds({ twoFactorCode: '123456' }), d);
    expect(u?.id).toBe('u1');
  });

  it('★rememberDevice=true 单独不得放行（M17）', async () => {
    // 审查实测：rememberDevice 让 authorize 在验证前直接 return user，
    // 32 条全绿。勾选意愿 ≠ 已经是可信设备。
    const d = deps({ isTrustedDevice: vi.fn(async () => false) });
    await expect(
      authorizeCredentials(creds({ rememberDevice: 'true' }), d),
    ).rejects.toThrow('TWO_FACTOR_REQUIRED');
  });

  it('可信设备 token 有效 → 跳过第二因子；无效 → 照常要码', async () => {
    const ok = deps({ isTrustedDevice: vi.fn(async () => true) });
    expect(
      (await authorizeCredentials(creds({ trustedDeviceToken: 't' }), ok))?.id,
    ).toBe('u1');

    const bad = deps({ isTrustedDevice: vi.fn(async () => false) });
    await expect(
      authorizeCredentials(creds({ trustedDeviceToken: 't' }), bad),
    ).rejects.toThrow('TWO_FACTOR_REQUIRED');
  });

  it('★限流触发 → 抛 RATE_LIMITED，且不查用户不发信（N6）', async () => {
    // 审查实测：把限流改成只记日志不拒绝，32 条全绿。
    const d = deps({ checkRateLimit: vi.fn(async () => ({ allowed: false })) });
    await expect(authorizeCredentials(creds(), d)).rejects.toThrow('RATE_LIMITED');
    expect(d.findUserByEmail).not.toHaveBeenCalled();
    expect(d.sendCodeEmail).not.toHaveBeenCalled();
  });

  it('★密码错 → 不发信（否则登录即邮件轰炸放大器）', async () => {
    const d = deps({ verifyPassword: vi.fn(async () => false) });
    expect(await authorizeCredentials(creds(), d)).toBeNull();
    expect(d.sendCodeEmail).not.toHaveBeenCalled();
    expect(d.issueCode).not.toHaveBeenCalled();
  });

  it('★验证码失败不得计入账户锁定（DoS 轴分离）', async () => {
    // 合并两条轴 = 攻击者只要知道邮箱就能用错码锁死受害者。
    const d = deps({
      verifyCode: vi.fn(async () => ({ ok: false as const, reason: 'MISMATCH' as const })),
    });
    await expect(
      authorizeCredentials(creds({ twoFactorCode: '000000' }), d),
    ).rejects.toThrow();
    expect(d.recordFailedAttempt).not.toHaveBeenCalled();
  });

  it('★签发被窗口拦下 → 抛 WINDOW_EXCEEDED 而非 SEND_FAILED', async () => {
    // 两者的用户动作完全不同：一个是"稍后再试"，一个是"重试发送"。
    // 我第一版把 throw 写在发信的 try 里，会被改写成 SEND_FAILED。
    const d = deps({
      issueCode: vi.fn(async () => ({ ok: false as const, reason: 'WINDOW_EXCEEDED' })),
    });
    await expect(authorizeCredentials(creds(), d)).rejects.toThrow(
      'TWO_FACTOR_WINDOW_EXCEEDED',
    );
    expect(d.sendCodeEmail).not.toHaveBeenCalled();
  });

  it('已有有效码时不重复发信（节流）', async () => {
    const d = deps({ hasActiveCode: vi.fn(async () => true) });
    await expect(authorizeCredentials(creds(), d)).rejects.toThrow(
      'TWO_FACTOR_REQUIRED',
    );
    expect(d.sendCodeEmail).not.toHaveBeenCalled();
    expect(d.issueCode).not.toHaveBeenCalled();
  });

  it('账户锁定 → 抛 ACCOUNT_LOCKED', async () => {
    const d = deps({ checkAccountLockout: vi.fn(async () => ({ locked: true })) });
    await expect(authorizeCredentials(creds(), d)).rejects.toThrow('ACCOUNT_LOCKED');
  });

  it('用户不存在 → 返回 null 且不发信', async () => {
    const d = deps({ findUserByEmail: vi.fn(async () => undefined) });
    expect(await authorizeCredentials(creds(), d)).toBeNull();
    expect(d.sendCodeEmail).not.toHaveBeenCalled();
  });

  it('缺 email/password → 直接 null，不触碰任何依赖', async () => {
    const d = deps();
    expect(await authorizeCredentials({ email: 'a@b.c' }, d)).toBeNull();
    expect(d.checkRateLimit).not.toHaveBeenCalled();
  });
});
