/**
 * 团队邀请的邮箱口径（#679 / #682）。
 *
 * - 入库：trim + 小写。邀请人输入 `Ryan.Pang@x.com` 与 `ryan.pang@x.com` 是同一个地址，
 *   重复邀请检查与接受时的匹配都按小写进行。
 * - 匹配：按「同一邮箱」（isSameMailbox，与注册去重同一口径）。注册会拒绝同一邮箱的 +别名，
 *   所以发给 `a+team@x.com` 的邀请只能由 `a@x.com` 的账号接受，否则邀请永远无法接受。
 */
import { or, sql, type SQL } from 'drizzle-orm';
import { isSameMailbox, normalizeEmail } from '@/lib/email-normalize';
import { teamInvitations, users } from '@/lib/prisma';

const GMAIL_HOSTS = ['gmail.com', 'googlemail.com'];

/** 邀请邮箱的规范存储形式；不像邮箱时返回 null。 */
export function canonicalInvitationEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** 与 email 可能属于同一邮箱的域名集合（gmail 与 googlemail 视为同一域）。 */
function mailboxHosts(email: string): string[] {
  const host = normalizeEmail(email).split('@')[1] ?? '';
  return host === 'gmail.com' ? GMAIL_HOSTS : [host];
}

/**
 * 邀请收件箱的 SQL 预筛：同域名的邀请（大小写不敏感）。精确的同一邮箱判定在内存里用
 * {@link matchesInvitationMailbox} 完成——Gmail 点号与 +别名无法用简单的 SQL 表达。
 */
export function invitationMailboxCandidates(email: string): SQL {
  const conds = mailboxHosts(email).map(
    (host) => sql`lower(${teamInvitations.email}) like ${`%@${escapeLike(host)}`}`,
  );
  return conds.length === 1 ? conds[0] : (or(...conds) as SQL);
}

/** 账号邮箱能否接受 / 拒绝发给 invitationEmail 的邀请。 */
export function matchesInvitationMailbox(accountEmail: string | null | undefined, invitationEmail: string): boolean {
  return isSameMailbox(accountEmail, invitationEmail);
}

/** 按同一邮箱查找已注册用户（精确小写地址或 emailNormalized 命中）。 */
export function userByMailbox(email: string): SQL {
  const normalized = normalizeEmail(email);
  return or(sql`lower(${users.email}) = ${email.toLowerCase()}`, sql`${users.emailNormalized} = ${normalized}`) as SQL;
}
