import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { getSession } from '@/lib/auth';
import { db, users, verificationTokens } from '@/lib/prisma';
import { sendVerificationEmail } from '@/lib/resend';
import { hashResetToken } from '@/lib/password-reset-tokens';
import { RateLimitPresets } from '@/lib/rate-limit';
import { checkRateLimitDistributed } from '@/lib/rate-limit-distributed';
import { EMAIL_VERIFY_NS } from '@/lib/email-verification-ns';

/**
 * POST /api/user/send-verification
 *
 * 给**当前登录用户**的注册邮箱发一封验证链接邮件。
 *
 * <h3>为什么需要它</h3>
 * `ai-quota.ts` 的 L0.5 闸门要求 Free 档必须 `emailVerified` 才解锁 AI，
 * 但此前**没有任何面向普通用户的路径写入该字段**：只有 seed 脚本、
 * `lib/db-bootstrap.ts` 的运维预置 admin、以及 OAuth 适配器透传，
 * 也没有发信/确认接口——凭账号密码注册的 Free 用户因此被永久锁死，
 * 而提示语却写着「验证邮件已发送至您注册邮箱」。本接口补上发信这一半。
 *
 * <h3>安全取舍</h3>
 * - 邮箱**取自会话**而非请求体：否则等于给任意登录用户一个向任意地址发信的喷口。
 * - 原始 token 只出现在邮件链接里，库存 `sha256(token)`——与 forgot-password
 *   同构（审计 #168）：只读 DB 泄露拿不到可直接使用的链接。
 * - 限流键**只按 userId**。★不要把 IP 拼进键：`getClientIp` 会读
 *   `x-forwarded-for` 首段，那是**客户端可控**的（非 CF 直连 / on-prem 转发
 *   等场景下 `cf-connecting-ip` 未必被上游强制覆写）。把可伪造的维度拼进键
 *   只会让攻击者每次换个伪造 IP 就拿到全新计数器，把 3 次/小时稀释成无限。
 *   `userId` 来自会话、不可伪造，本就按人隔离，无 NAT 误伤之虞。
 *   （对比 forgot-password 用 `ip:email`：那里无会话、email 来自请求体，
 *   IP 是仅有的维度，属被迫；此处有可信维度就不该退而求其次。）
 *   沿用 PASSWORD_RESET 预设（1 小时 3 次）。
 * - 已验证过的账号直接返回成功且**不发信**：避免把它当作重复发信的通道。
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 32 字节随机 token（十六进制）。Web Crypto，Node 与 Workers 均可用。 */
function randomToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * ★签名保留 `_request` 但**故意不读**：本路由的邮箱一律取自会话。
 * 收掉参数会让「请求体被忽略」这条安全保证在类型层面消失、无从测起，
 * 也会让将来有人加回 body 解析时失去这行提醒。
 */
export async function POST(_request: NextRequest) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  const rl = await checkRateLimitDistributed(
    `send-verification:${userId}`,
    RateLimitPresets.PASSWORD_RESET,
  );
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many verification emails. Please try again later.' },
      {
        status: 429,
        headers: rl.retryAfterSeconds
          ? { 'Retry-After': String(rl.retryAfterSeconds) }
          : undefined,
      },
    );
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { id: true, email: true, emailVerified: true },
  });
  if (!user?.email) {
    return NextResponse.json(
      { error: 'No email address on this account' },
      { status: 400 },
    );
  }
  // 已验证：不重复发信，但也不报错——前端据此把区块切到「已验证」态即可。
  if (user.emailVerified) {
    return NextResponse.json({ ok: true, alreadyVerified: true });
  }

  const email = user.email.toLowerCase();

  // 作废该邮箱此前未用的验证 token：一次只允许一条链接有效，
  // 否则连点若干次会留下多条可用链接，扩大被窃取时的可用窗口。
  const identifier = EMAIL_VERIFY_NS + email;

  await db
    .delete(verificationTokens)
    .where(eq(verificationTokens.identifier, identifier));

  const raw = randomToken();
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

  await db.insert(verificationTokens).values({
    identifier,
    token: hashResetToken(raw),
    expires,
  });

  // ★发信失败必须响亮：sendVerificationEmail 在 Resend 拒绝投递时抛错。
  //   若吞掉它返回 {ok:true}，用户看到「已发送」却永远收不到信，而旧 token
  //   已被作废——用户被锁在 AI 闸门外且无从排查。同时删掉刚写入的 token，
  //   避免留下一条永远送不出去、却占着「一次只允许一条」名额的死行。
  try {
    await sendVerificationEmail(email, raw);
  } catch (err) {
    await db
      .delete(verificationTokens)
      .where(eq(verificationTokens.identifier, identifier));
    console.error('[send-verification] delivery failed:', err);
    return NextResponse.json(
      { error: 'Could not send the verification email. Please try again later.' },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true });
}

/** 该邮箱当前是否有未过期的验证 token（供设置页显示「已发送」态）。 */
export async function GET() {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const user = await db.query.users.findFirst({
    where: eq(users.id, session.user.id),
    columns: { email: true, emailVerified: true },
  });
  if (!user?.email) {
    return NextResponse.json({ error: 'No email address on this account' }, { status: 400 });
  }
  return NextResponse.json({
    email: user.email,
    verified: !!user.emailVerified,
  });
}
