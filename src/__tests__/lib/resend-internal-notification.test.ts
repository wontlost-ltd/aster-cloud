// sendInternalNotificationEmail：投递被拒必须抛错（Resend 不抛异常而是返回 error）；未配置时静默返回 false。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 与 send-verification-email.test.ts 同约定：saas / on-prem 两个 project 都会跑本文件。
const MODE = process.env.DEPLOYMENT_MODE ?? 'saas';
(globalThis as unknown as { __DEPLOYMENT_MODE__: string }).__DEPLOYMENT_MODE__ = MODE;
const IS_SAAS_BUILD = MODE === 'saas';

const sendMock = vi.fn();
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

const message = { to: ['support@wontlost.com'], subject: 's', html: '<p>h</p>', text: 't' };

describe('sendInternalNotificationEmail', () => {
  const OLD_KEY = process.env.RESEND_API_KEY;
  beforeEach(() => {
    vi.resetModules();
    sendMock.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    if (OLD_KEY === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = OLD_KEY;
    vi.restoreAllMocks();
  });

  it.runIf(IS_SAAS_BUILD)('已配置 → 带 html/text 投递并返回 true', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    sendMock.mockResolvedValue({ data: { id: '1' }, error: null });
    const { sendInternalNotificationEmail } = await import('@/lib/resend');
    await expect(sendInternalNotificationEmail(message)).resolves.toBe(true);
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ to: message.to, subject: 's', html: '<p>h</p>', text: 't' }));
  });

  it.runIf(IS_SAAS_BUILD)('投递被拒 → 抛错，日志不含正文', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    sendMock.mockResolvedValue({ data: null, error: { name: 'validation_error', message: 'domain not verified' } });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { sendInternalNotificationEmail } = await import('@/lib/resend');
    await expect(sendInternalNotificationEmail(message)).rejects.toThrow(/RESEND_SEND_REJECTED/);
    expect(JSON.stringify(err.mock.calls)).not.toContain('<p>h</p>');
  });

  it('未配置 Resend → 返回 false，不投递', async () => {
    delete process.env.RESEND_API_KEY;
    const { sendInternalNotificationEmail } = await import('@/lib/resend');
    await expect(sendInternalNotificationEmail(message)).resolves.toBe(false);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
