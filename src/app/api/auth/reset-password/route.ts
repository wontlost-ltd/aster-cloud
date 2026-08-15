import { NextRequest, NextResponse } from 'next/server';
import { db, passwordResetTokens, users } from '@/lib/prisma';
import { hashPassword } from '@/lib/auth';
import { hashResetToken } from '@/lib/password-reset-tokens';
import { RateLimitPresets, getClientIp } from '@/lib/rate-limit';
import { checkRateLimitDistributed } from '@/lib/rate-limit-distributed';
import { eq } from 'drizzle-orm';

export async function POST(request: NextRequest) {
  try {
    const { token, password } = await request.json();

    if (!token || typeof token !== 'string') {
      return NextResponse.json(
        { error: 'Invalid reset token' },
        { status: 400 }
      );
    }

    if (!password || typeof password !== 'string' || password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters long' },
        { status: 400 }
      );
    }

    // Rate limit by IP + token to blunt brute-forcing of reset tokens.
    // 审计 #168：分布式（KV）限流，避免 Workers per-isolate 计数被绕过；非 CF 环境回退内存。
    const clientIp = getClientIp(request);
    const rl = await checkRateLimitDistributed(
      `reset-password:${clientIp}:${hashResetToken(token)}`,
      RateLimitPresets.PASSWORD_RESET,
    );
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'Too many password reset attempts. Please try again later.' },
        { status: 429, headers: rl.retryAfterSeconds ? { 'Retry-After': String(rl.retryAfterSeconds) } : undefined },
      );
    }

    // Look up by sha256(token): DB stores only the hash (audit #168).
    const resetToken = await db.query.passwordResetTokens.findFirst({
      where: eq(passwordResetTokens.token, hashResetToken(token)),
    });

    if (!resetToken) {
      return NextResponse.json(
        { error: 'Invalid or expired reset token' },
        { status: 400 }
      );
    }

    // Check if token has expired
    if (resetToken.expires < new Date()) {
      // Clean up expired token
      await db.delete(passwordResetTokens).where(eq(passwordResetTokens.id, resetToken.id));
      return NextResponse.json(
        { error: 'Reset token has expired' },
        { status: 400 }
      );
    }

    // Find the user
    const user = await db.query.users.findFirst({
      where: eq(users.email, resetToken.email),
    });

    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 400 }
      );
    }

    // Hash the new password
    const passwordHash = await hashPassword(password);

    // Update user password
    await db.update(users).set({ passwordHash }).where(eq(users.id, user.id));

    // ★吊销该用户全部「可信设备」（issue #400）。
    //   走到这条路径通常意味着密码已丢失或疑似泄露——此时留着"跳过第二因子"
    //   的设备，等于给攻击者留了一条只需旧密码的通道。
    //   失败不阻断改密：密码已经改掉了，回滚反而更糟；记日志供排查。
    try {
      const { revokeAllTrustedDevices } = await import('@/lib/trusted-device');
      const revoked = await revokeAllTrustedDevices(user.id);
      if (revoked > 0) {
        console.warn(`[auth] 重置密码后吊销 ${revoked} 台可信设备: user=${user.id}`);
      }
    } catch (err) {
      console.error('[auth] 重置密码后吊销可信设备失败:', err);
    }

    // Delete the used token
    await db.delete(passwordResetTokens).where(eq(passwordResetTokens.id, resetToken.id));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Reset password error:', error);
    return NextResponse.json(
      { error: 'Something went wrong' },
      { status: 500 }
    );
  }
}
