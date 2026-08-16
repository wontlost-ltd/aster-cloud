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

// ★mock 掉 next-auth：真包会把整个 Next server runtime 拉进 vitest
//   （next-auth/lib/env.js 依赖 'next/server'），本模块正是为了可测才抽出来的，
//   不该因为一个 error 基类又把重依赖引回来。
//   这里复刻 CredentialsSignin 的**关键契约**：它有一个 `code` 字段，
//   Auth.js 会把该字段透传到重定向 URL 的 code 参数。
vi.mock('next-auth', () => ({
  CredentialsSignin: class extends Error {
    code = 'credentials';
  },
}));

import { CredentialsSignin } from 'next-auth';

import {
  authorizeCredentials,
  TwoFactorSignin,
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
    // 默认未绑定 TOTP → 走邮件码分支（既有用例的前提不变）。
    hasTotpEnabled: vi.fn(async () => false),
    verifyTotp: vi.fn(async () => ({ ok: true }) as const),
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
  // ── 传给前端的契约：必须是 code，不是 message（线上事故）─────────────
  //
  // ★这一组是本文件此前**最大的盲区**：原有断言全用 `.toThrow('TWO_FACTOR_REQUIRED')`
  //   —— message 确实是那个值，测试全绿；但 Auth.js v5 把 authorize() 的抛错
  //   归一化成 error='CredentialsSignin'，**message 根本传不到前端**。
  //   前端比较 result.error === 'TWO_FACTOR_REQUIRED' 恒为 false，
  //   于是密码正确的用户看到「邮箱或密码错误」，第二屏永远出不来。
  //   服务端与前端各自都"对"，坏在中间那条缝——所以必须显式断言 code。
  describe('★错误必须带 Auth.js 可透传的 code（否则前端收不到）', () => {
    async function catchErr(run: () => Promise<unknown>): Promise<unknown> {
      try {
        await run();
        throw new Error('预期抛错但没有');
      } catch (e) {
        return e;
      }
    }

    it('★TWO_FACTOR_REQUIRED 必须以 code 形式传出', async () => {
      const d = deps();
      const err = (await catchErr(() => authorizeCredentials(creds(), d))) as {
        code?: string;
      };
      expect(err.code, 'code 缺失 → 前端拿不到，第二屏出不来').toBe(
        'TWO_FACTOR_REQUIRED',
      );
    });

    it('★必须是 CredentialsSignin 子类——只有它的 code 会被透传', async () => {
      const d = deps();
      const err = await catchErr(() => authorizeCredentials(creds(), d));
      // 裸 Error 的 code 不会进重定向 URL，等于没传。
      expect(err).toBeInstanceOf(TwoFactorSignin);
      expect(err).toBeInstanceOf(CredentialsSignin);
    });

    it('★验证码错误同样带 code', async () => {
      const d = deps({
        hasActiveCode: async () => true,
        verifyCode: async () => ({ ok: false, reason: 'MISMATCH' }) as const,
      });
      const err = (await catchErr(() =>
        authorizeCredentials(creds({ twoFactorCode: '000000' }), d),
      )) as { code?: string };
      expect(err.code).toBe('TWO_FACTOR_MISMATCH');
    });

    it('★code 里不得出现验证码或密码', async () => {
      const d = deps();
      const err = (await catchErr(() =>
        authorizeCredentials(creds({ password: 'sup3r-secret' }), d),
      )) as { code?: string };
      expect(err.code ?? '').not.toContain('sup3r-secret');
    });
  });

  // ── TOTP 分支（issue #400 第二步）────────────────────────────────
  //
  // ★用户选定的策略：已绑定验证器的用户**完全不走邮件**——不发信、
  //   也不接受邮件码。留邮件作后备等于把强度降回"控制邮箱即可登录"。
  describe('★TOTP 已绑定时的分支', () => {
    it('★已绑 TOTP 且未提交码 → 抛 TOTP_REQUIRED，且**不得发任何邮件**', async () => {
      const d = deps({ hasTotpEnabled: vi.fn(async () => true) });
      await expect(authorizeCredentials(creds(), d)).rejects.toThrow('TWO_FACTOR_TOTP_REQUIRED');
      // 这条是本分支的核心承诺：绑了 App 就不该再收到邮件。
      expect(d.sendCodeEmail, '已绑 TOTP 却仍发信').not.toHaveBeenCalled();
      expect(d.issueCode, '已绑 TOTP 却仍签发邮件码').not.toHaveBeenCalled();
    });

    it('★TOTP 码正确 → 放行，且不碰邮件码路径', async () => {
      const d = deps({
        hasTotpEnabled: vi.fn(async () => true),
        verifyTotp: vi.fn(async () => ({ ok: true }) as const),
      });
      const user = await authorizeCredentials(creds({ twoFactorCode: '123456' }), d);
      expect(user?.id).toBe('u1');
      expect(d.verifyCode, '不该走邮件码校验').not.toHaveBeenCalled();
      expect(d.sendCodeEmail).not.toHaveBeenCalled();
    });

    it('★TOTP 码错误 → 抛 TOTP_MISMATCH，且**不计入账户锁定**', async () => {
      // 与邮件码同理：计入锁定会让知道邮箱的人用错码把受害者锁死。
      const d = deps({
        hasTotpEnabled: vi.fn(async () => true),
        verifyTotp: vi.fn(async () => ({ ok: false, reason: 'MISMATCH' }) as const),
      });
      await expect(
        authorizeCredentials(creds({ twoFactorCode: '000000' }), d),
      ).rejects.toThrow('TWO_FACTOR_TOTP_MISMATCH');
      expect(d.recordFailedAttempt, 'TOTP 错误被计入了账户锁定').not.toHaveBeenCalled();
    });

    it('★重放被拒时也要如实传出 REPLAY，不能混成 MISMATCH', async () => {
      const d = deps({
        hasTotpEnabled: vi.fn(async () => true),
        verifyTotp: vi.fn(async () => ({ ok: false, reason: 'REPLAY' }) as const),
      });
      await expect(
        authorizeCredentials(creds({ twoFactorCode: '123456' }), d),
      ).rejects.toThrow('TWO_FACTOR_TOTP_REPLAY');
    });

    it('★未绑 TOTP 的用户完全不受影响——仍走邮件码', async () => {
      // 回归保护：TOTP 分支不得改变既有用户的登录方式。
      const d = deps({ hasTotpEnabled: vi.fn(async () => false) });
      await expect(authorizeCredentials(creds(), d)).rejects.toThrow('TWO_FACTOR_REQUIRED');
      expect(d.sendCodeEmail, '未绑 TOTP 却没发邮件').toHaveBeenCalled();
    });

    it('★TOTP 分支必须在发信**之前**判断（否则先发一封没人要的信）', async () => {
      const d = deps({ hasTotpEnabled: vi.fn(async () => true) });
      await expect(authorizeCredentials(creds(), d)).rejects.toThrow();
      // hasActiveCode 是邮件分支的第一步；被调用即说明顺序错了。
      expect(d.hasActiveCode, 'TOTP 判断晚于邮件分支').not.toHaveBeenCalled();
    });
  });

});
