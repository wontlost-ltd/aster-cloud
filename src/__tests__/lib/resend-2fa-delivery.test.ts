// 2FA 验证码发信必须在**投递被拒**时抛错（issue #400）。
//
// ## 为什么单独测这一条
//
// Resend SDK 对被拒绝的投递**不抛异常**，而是返回 `{ data: null, error }`。
// 裸 `await resend.emails.send(...)` 会把「域名未验证 / 超额 / 收件人被封」
// 全部吞掉、函数正常返回——上游 `authorize-credentials` 里那个
// `catch → TWO_FACTOR_SEND_FAILED` 因此永远不触发：
// 用户被告知"验证码已发送"，却永远收不到，日志里也没有任何痕迹。
//
// 这个失败模式在线上**无法从 Worker 日志区分**：被拒的发信与成功的发信
// 有完全相同的日志（无异常）与相近的耗时。所以只能在这一层锁住。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `__DEPLOYMENT_MODE__` 是 build-time macro，vitest 下不存在（deployment-mode.test.ts
// 的注释也记了这一点）。resend.ts 的 ensureResend 直接引用它以便 DCE，
// 故这里显式置为 'saas' 来走 SaaS 分支——on-prem 分支会安静返回 null，
// 那样本文件测的就不是投递失败了。
(globalThis as unknown as { __DEPLOYMENT_MODE__: string }).__DEPLOYMENT_MODE__ = 'saas';

const sendMock = vi.fn();

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

describe('2FA 验证码发信的失败可见性（issue #400）', () => {
  const OLD_ENV = process.env.RESEND_API_KEY;

  beforeEach(() => {
    vi.resetModules();
    sendMock.mockReset();
    process.env.RESEND_API_KEY = 're_test_key';
  });

  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = OLD_ENV;
  });

  it('★投递被拒（error 非空）必须抛错，而不是静默返回', async () => {
    // Resend 拒绝时的真实返回形态：不抛异常，只在 error 字段里报。
    sendMock.mockResolvedValue({
      data: null,
      error: { name: 'validation_error', message: 'The wontlost.com domain is not verified' },
    });

    const { sendTwoFactorCodeEmail } = await import('@/lib/resend');

    await expect(
      sendTwoFactorCodeEmail('user@example.com', '123456', 10),
    ).rejects.toThrow(/RESEND_SEND_REJECTED/);
  });

  it('★抛出的错误里不得包含验证码本身', async () => {
    // 验证码进日志/错误上报 = 第二因子对任何能读日志的人可见。
    sendMock.mockResolvedValue({
      data: null,
      error: { name: 'rate_limit_exceeded', message: 'Too many requests' },
    });

    const { sendTwoFactorCodeEmail } = await import('@/lib/resend');

    await expect(
      sendTwoFactorCodeEmail('user@example.com', '987654', 10),
    ).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('987654') }),
    );
  });

  it('投递成功（error 为 null）正常返回，不抛错', async () => {
    sendMock.mockResolvedValue({ data: { id: 'msg_123' }, error: null });

    const { sendTwoFactorCodeEmail } = await import('@/lib/resend');

    await expect(
      sendTwoFactorCodeEmail('user@example.com', '123456', 10),
    ).resolves.toBeUndefined();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
