/**
 * 新试点申请的内部通知邮件（仅 SaaS）。
 *
 * 申请落库成功后由路由在响应之后调用；邮件只发给运营收件人，内容含用户提交的原文，
 * 因此 HTML 一律转义，主题剔除换行与控制字符以防邮件头注入。
 */
import type { PilotApplicationInput } from '@/lib/pilot-applications';
import { escapeHtml, sendInternalNotificationEmail } from '@/lib/resend';
import { safeEnv } from '@/lib/runtime/safe-env';

export const DEFAULT_NOTIFY_TO = 'support@wontlost.com';
const MAX_PAIN_POINT = 1000;
const MAX_SUBJECT = 200;

export interface PilotNotification {
  subject: string;
  html: string;
  text: string;
}

/** 收件人每次调用时读取（同 RESEND_FROM_EMAIL，不能在模块顶层固化），支持逗号分隔多个。 */
export function resolveNotifyRecipients(): string[] {
  const configured = (safeEnv('PILOT_APPLICATION_NOTIFY_TO') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : [DEFAULT_NOTIFY_TO];
}

/** 折叠所有空白与控制字符（含 CR/LF），并限长。 */
function singleLine(value: string, max = MAX_SUBJECT): string {
  const flat = value.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function appBaseUrl(): string {
  return (safeEnv('NEXT_PUBLIC_APP_URL') || 'https://aster-lang.cloud').replace(/\/+$/, '');
}

export function buildPilotApplicationNotification(
  v: PilotApplicationInput,
  submittedAt: Date,
): PilotNotification {
  const useCase = v.useCases.length > 1 ? `${v.useCases[0]} +${v.useCases.length - 1}` : v.useCases[0];
  const subject = singleLine(`[Aster] New pilot application — ${useCase} — ${v.company || v.emailDomain}`);

  const utm = (
    [
      ['source', v.utmSource],
      ['medium', v.utmMedium],
      ['campaign', v.utmCampaign],
      ['term', v.utmTerm],
      ['content', v.utmContent],
    ] as const
  )
    .filter(([, val]) => val)
    .map(([k, val]) => `${k}=${val}`)
    .join(', ');

  const rows: Array<[string, string]> = [
    ['Company', v.company],
    ['Email', v.email],
    ['Email domain', `${v.emailDomain} (${v.freeMailDomain ? 'personal mailbox domain' : 'business domain'})`],
    ['Role', v.role],
    ['Use cases', v.useCases.join(', ')],
    ['Pain point', v.painPoint ? truncate(v.painPoint, MAX_PAIN_POINT) : '-'],
    ['Landing page', `${v.landingPage} (${v.locale})`],
    ['UTM', utm || '-'],
    ['Referrer', v.referrerHost ?? '-'],
    ['Submitted at', submittedAt.toISOString()],
  ];
  const adminUrl = `${appBaseUrl()}/admin/demand`;

  const text = [...rows.map(([k, val]) => `${k}: ${val}`), '', `Admin: ${adminUrl}`].join('\n');
  const html = [
    '<h2>New pilot application</h2>',
    '<table cellpadding="4" style="border-collapse:collapse">',
    ...rows.map(
      ([k, val]) =>
        `<tr><td style="vertical-align:top"><strong>${escapeHtml(k)}</strong></td>` +
        `<td style="white-space:pre-wrap">${escapeHtml(val)}</td></tr>`,
    ),
    '</table>',
    `<p><a href="${escapeHtml(adminUrl)}">Open demand dashboard</a></p>`,
  ].join('\n');

  return { subject, html, text };
}

/**
 * 发送通知。失败只记录异常消息（不带邮件正文），不向上抛出：
 * 调用方在响应之后异步调用，申请本身已落库。
 */
export async function notifyPilotApplication(v: PilotApplicationInput, now = new Date()): Promise<void> {
  try {
    const message = buildPilotApplicationNotification(v, now);
    await sendInternalNotificationEmail({ to: resolveNotifyRecipients(), ...message });
  } catch (err) {
    console.error('[pilot-applications] notification failed:', err instanceof Error ? err.message : 'unknown');
  }
}
