import { NextRequest, NextResponse } from 'next/server';
import { db, passwordResetTokens, users } from '@/lib/prisma';
import { sendPasswordResetEmail } from '@/lib/resend';
import { hashResetToken } from '@/lib/password-reset-tokens';
import { RateLimitPresets, getClientIp } from '@/lib/rate-limit';
import { checkRateLimitDistributed } from '@/lib/rate-limit-distributed';
import { eq } from 'drizzle-orm';
import { normalizeEmail } from '@/lib/email-normalize';

// Generate secure random bytes using Web Crypto API (works in both Node.js and Cloudflare Workers)
function randomBytes(length: number): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
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

    // 先按精确地址找账号；找不到再按同一邮箱（emailNormalized）找（#682）：注册会拒绝已有账号邮箱的
    // +别名，用户可能只记得另一种写法。重置信一律发到账号实际登记的地址（同一邮箱，收件人不变），
    // 令牌也绑定该地址，reset-password 按它找回账号。
    const lower = email.toLowerCase();
    const normalized = normalizeEmail(lower);
    const user =
      (await db.query.users.findFirst({ where: eq(users.email, lower) })) ??
      (normalized ? await db.query.users.findFirst({ where: eq(users.emailNormalized, normalized) }) : undefined);

    // Always return success to prevent email enumeration attacks
    if (!user?.email) {
      return NextResponse.json({ success: true });
    }
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

    // Send reset email with the raw token
    await sendPasswordResetEmail(user.email, token);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Forgot password error:', error);
    return NextResponse.json(
      { error: 'Something went wrong' },
      { status: 500 }
    );
  }
}
