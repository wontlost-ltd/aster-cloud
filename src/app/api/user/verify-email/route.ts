import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db, users, verificationTokens } from '@/lib/prisma';
import { hashResetToken } from '@/lib/password-reset-tokens';
import { EMAIL_VERIFY_NS } from '@/lib/email-verification-ns';
import { RateLimitPresets, getClientIp } from '@/lib/rate-limit';
import { checkRateLimitDistributed } from '@/lib/rate-limit-distributed';

/**
 * POST /api/user/verify-email  Body: { token }
 *
 * 用邮件链接里的原始 token 兑换「邮箱已验证」。
 *
 * <h3>为什么不要求登录</h3>
 * 用户很可能在另一台设备/浏览器点开邮件链接。持有一次性 token 本身就是
 * 凭据；要求会话只会把「换设备点链接」变成失败路径，并不增加安全性
 * （token 已按 identifier 绑定到具体邮箱、24h 过期、用后即焚）。
 *
 * <h3>安全取舍</h3>
 * - 按 `sha256(token)` 查库：只读 DB 泄露拿不到可直接使用的链接（审计 #168）。
 * - **先删 token 再写 emailVerified**，且删除带 token 条件——并发双击时
 *   只有删到行的那次继续，另一次落到「无效或已过期」。避免同一 token 被复用。
 * - 过期 token 一律删除后再报错：留着只会让后续尝试反复命中同一条死行。
 * - 按 IP 限流：token 是 32 字节随机，穷举不现实，但仍挡住扫描式探测。
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const clientIp = getClientIp(request);
  const rl = await checkRateLimitDistributed(
    `verify-email:${clientIp}`,
    RateLimitPresets.LOGIN,
  );
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many attempts. Please try again later.' },
      {
        status: 429,
        headers: rl.retryAfterSeconds
          ? { 'Retry-After': String(rl.retryAfterSeconds) }
          : undefined,
      },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const token = (body as { token?: unknown } | null)?.token;
  if (typeof token !== 'string' || token.length === 0) {
    return NextResponse.json({ error: 'token is required' }, { status: 400 });
  }

  const hashed = hashResetToken(token);
  const row = await db.query.verificationTokens.findFirst({
    where: eq(verificationTokens.token, hashed),
  });
  if (!row) {
    return NextResponse.json(
      { error: 'Invalid or expired verification link' },
      { status: 400 },
    );
  }

  // ★命名空间校验必须在**任何删除之前**：该表与 Auth.js magic-link 共用
  //   （见 EMAIL_VERIFY_NS 注释）。若放在删除之后，一条登录魔链会先被本端点
  //   删掉再被拒绝——等于把别人的登录链接消费掉。
  if (!row.identifier.startsWith(EMAIL_VERIFY_NS)) {
    return NextResponse.json(
      { error: 'Invalid or expired verification link' },
      { status: 400 },
    );
  }
  const email = row.identifier.slice(EMAIL_VERIFY_NS.length);

  if (row.expires.getTime() < Date.now()) {
    await db
      .delete(verificationTokens)
      .where(eq(verificationTokens.token, hashed));
    return NextResponse.json(
      { error: 'Invalid or expired verification link' },
      { status: 400 },
    );
  }

  // ★先删后写，并把 token 作为删除条件：并发双击时只有真正删到行的那次
  //   继续往下写，另一次拿到 0 行、落到「无效」分支。
  const deleted = await db
    .delete(verificationTokens)
    .where(
      and(
        eq(verificationTokens.identifier, row.identifier),
        eq(verificationTokens.token, hashed),
      ),
    )
    .returning({ token: verificationTokens.token });
  if (deleted.length === 0) {
    return NextResponse.json(
      { error: 'Invalid or expired verification link' },
      { status: 400 },
    );
  }

  const updated = await db
    .update(users)
    .set({ emailVerified: new Date() })
    .where(eq(users.email, email))
    .returning({ id: users.id });

  if (updated.length === 0) {
    // token 有效但邮箱已不存在（改邮箱/销号）。不当作成功。
    return NextResponse.json(
      { error: 'Invalid or expired verification link' },
      { status: 400 },
    );
  }

  return NextResponse.json({ ok: true });
}
