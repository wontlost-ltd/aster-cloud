// 试点申请内部通知：主题清洗、HTML 转义、免费邮箱标记、痛点截断、收件人配置、失败只记分类。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@/lib/resend', async () => {
  const actual = await vi.importActual<typeof import('@/lib/resend')>('@/lib/resend');
  return { ...actual, sendInternalNotificationEmail: mocks.send };
});

import {
  DEFAULT_NOTIFY_TO,
  buildPilotApplicationNotification,
  notifyPilotApplication,
  resolveNotifyRecipients,
} from '@/lib/email/pilot-application-notification';
import type { PilotApplicationInput } from '@/lib/pilot-applications';

const base: PilotApplicationInput = {
  email: 'jane@insurer.example',
  emailDomain: 'insurer.example',
  freeMailDomain: false,
  company: 'Example Mutual',
  role: 'actuarial_pricing',
  useCases: ['insurance_rating'],
  painPoint: 'Rating rules live in spreadsheets',
  landingPage: 'insurance-rating',
  locale: 'en',
  utmSource: 'linkedin',
  utmMedium: null,
  utmCampaign: 'q4',
  utmTerm: null,
  utmContent: null,
  referrerHost: 'www.linkedin.com',
};
const at = new Date('2026-11-02T08:00:00.000Z');

beforeEach(() => {
  mocks.send.mockReset().mockResolvedValue(true);
  delete process.env.PILOT_APPLICATION_NOTIFY_TO;
});
afterEach(() => vi.restoreAllMocks());

describe('buildPilotApplicationNotification', () => {
  it('主题含用例与公司；正文含全部字段与 /admin/demand 链接', () => {
    const m = buildPilotApplicationNotification(base, at);
    expect(m.subject).toBe('[Aster] New pilot application — insurance_rating — Example Mutual');
    for (const s of ['Example Mutual', 'jane@insurer.example', 'insurer.example (business domain)', 'actuarial_pricing',
      'insurance_rating', 'Rating rules live in spreadsheets', 'insurance-rating (en)', 'source=linkedin, campaign=q4',
      'www.linkedin.com', '2026-11-02T08:00:00.000Z', '/admin/demand']) {
      expect(m.text).toContain(s);
      expect(m.html).toContain(s.replace('/admin/demand', '/admin/demand'));
    }
  });

  it('个人邮箱域名被标出；多用例在主题里折叠', () => {
    const m = buildPilotApplicationNotification(
      { ...base, freeMailDomain: true, emailDomain: 'gmail.com', useCases: ['insurance_rating', 'other'] }, at);
    expect(m.text).toContain('gmail.com (personal mailbox domain)');
    expect(m.subject).toContain('insurance_rating +1');
  });

  it('用户文本全部 HTML 转义', () => {
    const m = buildPilotApplicationNotification(
      { ...base, company: '<script>alert(1)</script>', painPoint: '"><img src=x onerror=1> & more' }, at);
    expect(m.html).not.toContain('<script>');
    expect(m.html).not.toContain('<img');
    expect(m.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(m.html).toContain('&quot;&gt;&lt;img src=x onerror=1&gt; &amp; more');
  });

  it('主题剔除换行与控制字符（防邮件头注入）并限长', () => {
    const m = buildPilotApplicationNotification({ ...base, company: 'Evil\r\nBcc: x@evil.test\u0000Co' }, at);
    expect(m.subject).not.toMatch(/[\r\n\u0000\u2028]/);
    expect(m.subject).toContain('Evil Bcc: x@evil.test Co');
    const long = buildPilotApplicationNotification({ ...base, company: 'a'.repeat(5000) }, at);
    expect(long.subject.length).toBeLessThanOrEqual(200);
  });

  it('痛点截断到 1000 字符；缺省字段显示 -', () => {
    const m = buildPilotApplicationNotification(
      { ...base, painPoint: 'p'.repeat(2000), utmSource: null, utmCampaign: null, referrerHost: null }, at);
    expect(m.text).toContain(`Pain point: ${'p'.repeat(1000)}…`);
    expect(m.text).not.toContain('p'.repeat(1001));
    expect(m.text).toContain('UTM: -');
    expect(m.text).toContain('Referrer: -');
    expect(buildPilotApplicationNotification({ ...base, painPoint: null }, at).text).toContain('Pain point: -');
  });
});

describe('notifyPilotApplication', () => {
  it('默认发给 support@wontlost.com；env 可覆盖（逗号分隔）', async () => {
    expect(resolveNotifyRecipients()).toEqual([DEFAULT_NOTIFY_TO]);
    await notifyPilotApplication(base, at);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ to: ['support@wontlost.com'] }));
    process.env.PILOT_APPLICATION_NOTIFY_TO = ' a@x.test , b@x.test ';
    expect(resolveNotifyRecipients()).toEqual(['a@x.test', 'b@x.test']);
    process.env.PILOT_APPLICATION_NOTIFY_TO = '  ';
    expect(resolveNotifyRecipients()).toEqual([DEFAULT_NOTIFY_TO]);
  });

  it('发送失败只记错误消息，不抛出，也不带邮件正文', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.send.mockRejectedValue(new Error('RESEND_SEND_REJECTED: validation_error'));
    await expect(notifyPilotApplication(base, at)).resolves.toBeUndefined();
    const logged = JSON.stringify(err.mock.calls);
    expect(logged).toContain('RESEND_SEND_REJECTED');
    expect(logged).not.toContain('jane@insurer.example');
    expect(logged).not.toContain('Rating rules');
  });
});
