import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * `sendVerificationEmail` 在 Resend **未配置**时的行为。
 *
 * 背景：同文件的 `sendTwoFactorCodeEmail` 已记录过这条教训——生产未配置时
 * 静默成功，会让调用方返回 {ok:true}、用户看到「已发送」却永远收不到信，
 * 而运维看不出原因（注释注明这在线上真实发生过）。本函数原先正是那样写的。
 *
 * ★on-prem 是既定例外：那里不接 SaaS 邮件服务，`ensureResend` 会因
 * `__DEPLOYMENT_MODE__ !== 'saas'` 直接返回 null，把链接打出来让 admin
 * 手动转交是约定（同 sendTeamInvitationEmail）。故判据是
 * `__DEPLOYMENT_MODE__ === 'saas' && production`。
 */

// `__DEPLOYMENT_MODE__` 是 build-time macro，vitest 下不存在
// （沿用 resend-2fa-delivery.test.ts 的既有约定，在 globalThis 上补齐）。
// ★不能硬编码 'saas'：本套件在 saas / on-prem **两个 project** 下各跑一遍，
//   写死会让 on-prem 那轮测到错误的分支。从 project 注入的 DEPLOYMENT_MODE 取值。
const MODE = process.env.DEPLOYMENT_MODE ?? 'saas';
(globalThis as unknown as { __DEPLOYMENT_MODE__: string }).__DEPLOYMENT_MODE__ = MODE;
const IS_SAAS_BUILD = MODE === 'saas';

describe('sendVerificationEmail — 未配置 Resend 时不得静默成功', () => {
  const ORIGINAL_KEY = process.env.RESEND_API_KEY;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.RESEND_API_KEY; // 触发 ensureResend 返回 null
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = ORIGINAL_KEY;
    vi.restoreAllMocks();
  });

  it.runIf(IS_SAAS_BUILD)('★SaaS 生产未配置 → 抛错（而非打日志后假装成功）', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { sendVerificationEmail } = await import('@/lib/resend');
    await expect(sendVerificationEmail('a@b.c', 'tok')).rejects.toThrow(
      /RESEND_NOT_CONFIGURED/,
    );
  });

  // ★这条守的是「修 Low 别修成新 High」：若把 `__DEPLOYMENT_MODE__ === 'saas'`
  //   这半个条件去掉，on-prem 生产会因抛错导致发信全挂。
  it.runIf(!IS_SAAS_BUILD)('★on-prem 生产未配置 → 打印链接给 admin 转交，不抛错', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { sendVerificationEmail } = await import('@/lib/resend');
    await expect(sendVerificationEmail('a@b.c', 'tok')).resolves.toBeUndefined();
  });

  it('非生产未配置 → 打印链接供本地调试，不抛错', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { sendVerificationEmail } = await import('@/lib/resend');
    await expect(sendVerificationEmail('a@b.c', 'tok')).resolves.toBeUndefined();
  });

  it.runIf(IS_SAAS_BUILD)('★抛错信息不含 token（一次性凭据不进日志/错误上报）', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { sendVerificationEmail } = await import('@/lib/resend');
    await expect(
      sendVerificationEmail('a@b.c', 'SECRET-TOKEN-VALUE'),
    ).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('SECRET-TOKEN-VALUE'),
      }) as Error,
    );
  });
});
