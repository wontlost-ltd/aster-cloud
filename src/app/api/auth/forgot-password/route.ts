import { NextRequest, NextResponse } from 'next/server';
import { db, passwordResetTokens, users } from '@/lib/prisma';
import { sendPasswordResetEmail } from '@/lib/resend';
import { hashResetToken } from '@/lib/password-reset-tokens';
import { RateLimitPresets, getClientIp } from '@/lib/rate-limit';
import { checkRateLimitDistributed } from '@/lib/rate-limit-distributed';
import { eq, or } from 'drizzle-orm';
import { runAfterResponse } from '@/lib/after-response';
import { normalizeEmail } from '@/lib/email-normalize';

// Generate secure random bytes using Web Crypto API (works in both Node.js and Cloudflare Workers)
function randomBytes(length: number): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 账号维度的找回密码节流（#696 → #714）。
 *
 * 不用硬性「每小时 N 封」：那会让攻击者每小时打几次就让受害者收不到信。改为短窗去重——同一账号
 * 5 分钟内只发 1 封，窗口内的重复请求直接跳过（上一封信里的链接仍有效，受害者照样能重置）；
 * 每日上限只作兜底防轰炸，取值宽松。去重先查：被去重挡下的请求不占当天额度。
 */
async function accountResetAllowed(userId: string): Promise<boolean> {
  const dedup = await checkRateLimitDistributed(
    `forgot-password:account:dedup:${userId}`,
    RateLimitPresets.PASSWORD_RESET_ACCOUNT_DEDUP,
  );
  if (!dedup.allowed) return false;
  const daily = await checkRateLimitDistributed(
    `forgot-password:account:daily:${userId}`,
    RateLimitPresets.PASSWORD_RESET_ACCOUNT_DAILY,
  );
  return daily.allowed;
}

/**
 * 按输入地址找账号：一次查询同时匹配精确地址与 emailNormalized（#682），精确地址优先。
 * 命中与否都只查一次库（#714 统一查库路径）。
 */
async function findResetAccount(lower: string) {
  const normalized = normalizeEmail(lower);
  const where = normalized
    ? or(eq(users.email, lower), eq(users.emailNormalized, normalized))
    : eq(users.email, lower);
  const rows = await db.query.users.findMany({ where, limit: 2 });
  return rows.find((u) => u.email?.toLowerCase() === lower) ?? rows[0];
}

/** 找账号、节流、换令牌、发信；全部在响应之后执行。 */
async function issueReset(lower: string): Promise<void> {
  // 重置信一律发到账号实际登记的地址（同一邮箱，收件人不变），令牌也绑定该地址，
  // reset-password 按它找回账号。
  const user = await findResetAccount(lower);
  if (!user?.email) return;
  if (!(await accountResetAllowed(user.id))) return;
  const accountEmail = user.email.toLowerCase();

  // Delete any existing tokens for this email
  await db.delete(passwordResetTokens).where(eq(passwordResetTokens.email, accountEmail));

  // Generate a secure raw token (only ever shipped in the emailed link).
  const token = randomBytes(32);

  // Token expires in 1 hour
  const expires = new Date();
  expires.setHours(expires.getHours() + 1);

  // Persist only sha256(token): a read-only DB leak cannot reconstruct the
  // usable reset link (audit #168, mirrors lib/renewal-tokens.ts).
  await db.insert(passwordResetTokens).values({
    id: globalThis.crypto.randomUUID(),
    email: accountEmail,
    token: hashResetToken(token),
    expires,
  });

  await sendPasswordResetEmail(user.email, token);
}

export async function POST(request: NextRequest) {
  try {
    const { email } = await request.json();

    if (!email || typeof email !== 'string') {
      return NextResponse.json(
        { error: 'Email is required' },
        { status: 400 }
      );
    }

    // Rate limit by IP + email to blunt reset-email bombing / user enumeration.
    // 审计 #168：分布式（KV）限流，避免 Workers per-isolate 计数被绕过；非 CF 环境回退内存。
    const clientIp = getClientIp(request);
    const rl = await checkRateLimitDistributed(
      `forgot-password:${clientIp}:${email.toLowerCase()}`,
      RateLimitPresets.PASSWORD_RESET,
    );
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'Too many password reset requests. Please try again later.' },
        { status: 429, headers: rl.retryAfterSeconds ? { 'Retry-After': String(rl.retryAfterSeconds) } : undefined },
      );
    }

    // 查库、节流、发信都放到响应之后（#714）：命中 / 未命中 / 去重走同一条同步路径，
    // 响应内容与耗时都不泄露账号是否存在。
    runAfterResponse(() => issueReset(email.toLowerCase()));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Forgot password error:', error);
    return NextResponse.json(
      { error: 'Something went wrong' },
      { status: 500 }
    );
  }
}
