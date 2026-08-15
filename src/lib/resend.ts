/* @deployment-mode-hot-gate
 * reason: dynamic import of `resend` SDK gated by direct __DEPLOYMENT_MODE__
 *         macro. on-prem next.config.ts also aliases `resend` package to
 *         false so even a missed gate cannot pull the SDK into the bundle.
 *         All public helpers fail-soft (no-op + log) when SDK unavailable,
 *         matching pre-existing behavior when RESEND_API_KEY was unset.
 */

// resend SDK is a heavy SaaS-only dep. The pre-existing module exported
// `resend: Resend | null` as a top-level value initialised at import time.
// That pulled `import { Resend } from 'resend'` into every bundle that
// transitively imported this module — including on-prem, despite gates.
//
// The hot-gate pattern: dynamic import gated by direct macro; instance
// cached after first await. All public helpers internally `await ensureResend()`
// and silently return when SDK is unavailable (on-prem) or unconfigured
// (RESEND_API_KEY missing in dev). Callers' existing fail-soft expectations
// are preserved.

import type { Resend } from 'resend';
import { safeEnv } from '@/lib/runtime/safe-env';

type ResendCtor = typeof Resend;

let _instance: Resend | null = null;
let _attempted = false;
let _ctorPromise: Promise<ResendCtor> | null = null;

async function loadResendCtor(): Promise<ResendCtor> {
  // Direct macro reference for proper DCE — see header comment.
  if (__DEPLOYMENT_MODE__ !== 'saas') {
    throw new Error(
      '[resend] Resend SDK is unavailable in on-prem build. ' +
        'Callers must gate by CAN_RESEND / IS_SAAS before reaching this module.',
    );
  }
  if (!_ctorPromise) {
    _ctorPromise = import('resend').then((mod) => mod.Resend);
  }
  return _ctorPromise;
}

/**
 * 获取 Resend 实例。on-prem 直接返回 null（不 throw —— 上游 helper
 * 已经有 null-check fail-soft 行为）。SaaS 模式：首次调用时 dynamic
 * import + 实例化；缺 RESEND_API_KEY 则返回 null + console.warn 一次。
 *
 * 调用方应：`const resend = await getResend(); if (!resend) return;`
 * （等价于原 `import { resend }` + 内联 null-check 的写法）。
 */
export async function getResend(): Promise<Resend | null> {
  return ensureResend();
}

async function ensureResend(): Promise<Resend | null> {
  if (_instance) return _instance;
  if (_attempted) return null;
  _attempted = true;

  if (__DEPLOYMENT_MODE__ !== 'saas') {
    // on-prem 安静返回 null —— 邮件路径是 SaaS-only。
    return null;
  }
  const apiKey = safeEnv('RESEND_API_KEY');
  if (!apiKey) {
    console.warn('RESEND_API_KEY is not set - emails will not be sent');
    return null;
  }
  const ResendCtor = await loadResendCtor();
  _instance = new ResendCtor(apiKey);
  return _instance;
}

/**
 * ★必须**每次调用时**读，不能在模块顶层求值（本次线上故障的根因）。
 *
 * OpenNext 的 `populateProcessEnv()` 是**逐请求**把 Cloudflare 绑定拷进
 * `process.env` 的；而模块顶层代码在 worker 冷启动、第一个请求进来**之前**
 * 就执行了。此时 `process.env.RESEND_FROM_EMAIL` 还是空的，
 * `const FROM_EMAIL = ... || fallback` 于是被**永久**固定成兜底值，
 * 后续请求即便 env 已就绪也永远读不到——常量已经算完了。
 *
 * 实测后果：发信人恒为 noreply@aster-lang.cloud（未在 Resend 验证的域），
 * Resend 拒收，用户看到「无法发送验证码」。
 *
 * 这与 `ensureResend()` 把 `safeEnv('RESEND_API_KEY')` 放在函数体内是同一个
 * 道理——那处当初就写对了，这两个常量漏了。
 */
function fromEmail(): string {
  return safeEnv('RESEND_FROM_EMAIL') || 'noreply@aster-lang.cloud';
}

function appUrl(): string {
  return safeEnv('NEXT_PUBLIC_APP_URL') || 'https://aster-lang.cloud';
}

// Escape HTML to prevent XSS attacks
function escapeHtml(text: string): string {
  const htmlEscapes: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return text.replace(/[&<>"']/g, (char) => htmlEscapes[char]);
}

// Email templates
export async function sendWelcomeEmail(email: string, name: string) {
  const resend = await ensureResend();
  if (!resend) return;

  const safeName = escapeHtml(name);

  await resend.emails.send({
    from: `Aster Cloud <${fromEmail()}>`,
    to: email,
    subject: 'Welcome to Aster Cloud!',
    html: `
      <h1>Welcome to Aster Cloud, ${safeName}!</h1>
      <p>Your 14-day Pro trial has started.</p>
      <p>Start building policies with:</p>
      <ul>
        <li>Unlimited policy executions</li>
        <li>Advanced PII detection</li>
        <li>Compliance reports</li>
      </ul>
      <p><a href="${appUrl()}/dashboard">Go to Dashboard</a></p>
    `,
  });
}

export async function sendTrialExpiringEmail(
  email: string,
  name: string,
  daysLeft: number
) {
  const resend = await ensureResend();
  if (!resend) return;

  const safeName = escapeHtml(name);

  await resend.emails.send({
    from: `Aster Cloud <${fromEmail()}>`,
    to: email,
    subject: `Your Pro trial ends in ${daysLeft} day${daysLeft > 1 ? 's' : ''}`,
    html: `
      <h1>Hi ${safeName},</h1>
      <p>Your Pro trial ends in <strong>${daysLeft} day${daysLeft > 1 ? 's' : ''}</strong>.</p>
      <p>After your trial, you'll lose access to:</p>
      <ul>
        <li>Unlimited executions</li>
        <li>Policy sharing</li>
        <li>Compliance reports</li>
        <li>API access</li>
      </ul>
      <p><a href="${appUrl()}/billing">Upgrade Now</a></p>
    `,
  });
}

export async function sendTrialEndedEmail(email: string, name: string) {
  const resend = await ensureResend();
  if (!resend) return;

  const safeName = escapeHtml(name);

  await resend.emails.send({
    from: `Aster Cloud <${fromEmail()}>`,
    to: email,
    subject: 'Your Pro trial has ended',
    html: `
      <h1>Hi ${safeName},</h1>
      <p>Your Pro trial has ended and your account has been downgraded to Free.</p>
      <p>You can still use Aster Cloud with limited features, or upgrade anytime.</p>
      <p><a href="${appUrl()}/billing">View Plans</a></p>
    `,
  });
}

export async function sendPasswordResetEmail(email: string, token: string) {
  const resend = await ensureResend();
  if (!resend) {
    console.log(`Password reset link: ${appUrl()}/reset-password?token=${token}`);
    return;
  }

  const resetLink = `${appUrl()}/reset-password?token=${token}`;

  await resend.emails.send({
    from: `Aster Cloud <${fromEmail()}>`,
    to: email,
    subject: 'Reset your password',
    html: `
      <h1>Reset your password</h1>
      <p>You requested a password reset for your Aster Cloud account.</p>
      <p>Click the link below to reset your password. This link expires in 1 hour.</p>
      <p><a href="${resetLink}">Reset Password</a></p>
      <p>If you didn't request this, you can safely ignore this email.</p>
    `,
  });
}

/**
 * 登录二次验证码（issue #400）。
 *
 * <p>★与本文件其它模板不同：Resend 未配置时**不把码打进日志**。
 * 其它模板打的是重置链接（本来就要发给用户、且一次性），而 2FA 码打进日志
 * 等于把第二因子写进任何能读日志的地方——运维、日志聚合、错误上报都能看到，
 * 二次验证就白做了。
 *
 * <p>开发环境确实需要拿到码，故只在 `NODE_ENV !== 'production'` 时输出，
 * 并显式标注这是开发便利而非正常路径。生产未配置 Resend 时**抛错**：
 * 静默失败会让用户卡在验证码界面且收不到信，而运维看不出原因。
 */
export async function sendTwoFactorCodeEmail(
  email: string,
  code: string,
  ttlMinutes: number,
) {
  const resend = await ensureResend();
  if (!resend) {
    if (process.env.NODE_ENV !== 'production') {
      // 开发便利：生产分支永不走到这里。
      console.log(`[dev-only] 2FA code for ${email}: ${code}`);
      return;
    }
    throw new Error(
      'RESEND_NOT_CONFIGURED: 无法发送二次验证码，登录将无法完成',
    );
  }

  // ★必须检查返回值里的 error：Resend SDK 对**被拒绝的投递**不抛异常，
  //   而是返回 { data: null, error }。裸 await 会把「域名未验证 / 超额 /
  //   收件人被封」全部吞掉，函数正常返回——上游 authorize-credentials 的
  //   catch 因此永远不触发，用户被告知"验证码已发送"却永远收不到，
  //   日志里也没有任何痕迹。这正是本 PR 在别处修的那类「静默失败」。
  //
  //   实测背景：线上曾出现 RESEND_API_KEY 未随部署生效的情况，
  //   当时唯一的线索是一条 warn；若换成投递被拒，连那条 warn 都不会有。
  const { error } = await resend.emails.send({
    from: `Aster Cloud <${fromEmail()}>`,
    to: email,
    subject: `${code} is your Aster Cloud sign-in code`,
    html: `
      <h1>Your sign-in code</h1>
      <p style="font-size:28px;letter-spacing:4px;font-weight:700">${code}</p>
      <p>This code expires in ${ttlMinutes} minutes and can only be used once.</p>
      <p>If you didn't try to sign in, someone may have your password —
         change it immediately.</p>
    `,
  });

  if (error) {
    // ★不把 code 写进日志（见本函数头部注释）；只记录 Resend 的错误分类。
    console.error('[resend] 2FA code delivery rejected:', error.name, error.message);
    throw new Error(`RESEND_SEND_REJECTED: ${error.name}`);
  }
}

export async function sendPaymentFailedEmail(email: string, name: string) {
  const resend = await ensureResend();
  if (!resend) return;

  const safeName = escapeHtml(name);

  await resend.emails.send({
    from: `Aster Cloud <${fromEmail()}>`,
    to: email,
    subject: 'Payment failed - action required',
    html: `
      <h1>Hi ${safeName},</h1>
      <p>We were unable to process your latest payment for Aster Cloud.</p>
      <p>Please update your payment method to avoid service interruption.</p>
      <p><a href="${appUrl()}/billing" style="display: inline-block; padding: 12px 24px; background-color: #DC2626; color: white; text-decoration: none; border-radius: 6px;">Update Payment Method</a></p>
      <p>If you believe this is an error, please contact our support team.</p>
    `,
  });
}

export async function sendTeamInvitationEmail(
  email: string,
  teamName: string,
  inviterName: string,
  token: string
): Promise<{ success: boolean; inviteUrl: string }> {
  const inviteUrl = `${appUrl()}/teams/invite?token=${token}`;
  const safeTeamName = escapeHtml(teamName);
  const safeInviterName = escapeHtml(inviterName);

  const resend = await ensureResend();
  if (!resend) {
    // On-prem 与 SaaS-without-key 行为一致：把链接 console.log 出来，
    // 让 admin/inviter 手动复制粘贴给被邀请人。原行为已经如此处理；
    // 这里保持兼容。
    console.log(`Team invitation link: ${inviteUrl}`);
    return { success: false, inviteUrl };
  }

  try {
    await resend.emails.send({
      from: `Aster Cloud <${fromEmail()}>`,
      to: email,
      subject: `You've been invited to join ${safeTeamName}`,
      html: `
        <h1>Team Invitation</h1>
        <p><strong>${safeInviterName}</strong> has invited you to join <strong>${safeTeamName}</strong> on Aster Cloud.</p>
        <p>Click the link below to accept the invitation:</p>
        <p><a href="${inviteUrl}" style="display: inline-block; padding: 12px 24px; background-color: #4F46E5; color: white; text-decoration: none; border-radius: 6px;">Accept Invitation</a></p>
        <p>This invitation will expire in 7 days.</p>
        <p>If you didn't expect this invitation, you can safely ignore this email.</p>
      `,
    });
    return { success: true, inviteUrl };
  } catch (error) {
    console.error('Failed to send team invitation email:', error);
    return { success: false, inviteUrl };
  }
}
