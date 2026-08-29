import { NextRequest, NextResponse } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { db, users } from '@/lib/prisma';
import { hashPassword } from '@/auth';
import { normalizeEmail } from '@/lib/email-normalize';
import { hashIp, recordSignupAttempt } from '@/lib/signup-rate-limit';
import { getClientIp, RateLimitPresets } from '@/lib/rate-limit';
import { checkRateLimitDistributed } from '@/lib/rate-limit-distributed';

/**
 * POST /api/auth/signup  Body: { email, password, name? }
 *
 * 用邮箱 + 密码创建账号。
 *
 * <h3>为什么需要它</h3>
 * 登录页早已支持 credentials（邮箱 + 密码 + 2FA），`authorize()` 也按
 * `passwordHash` 校验——但**没有任何自助路径能创建带密码的账号**：注册页是
 * OAuth-only（文件头原先就写着 "no email/password yet"），Auth.js 适配器的
 * `createUser` 不接受 `passwordHash`。于是「用邮箱注册」这条路走不通。
 * （运维预置路径一直存在：`lib/db-bootstrap.ts` 的 ADMIN_INITIAL_PASSWORD
 * 会建带密码的 admin 账号。此处说的是**自助**注册。）
 *
 * <h3>安全取舍</h3>
 * - **邮箱枚举**：已注册时返回与成功**同形**的 200，不泄露该邮箱是否存在。
 *   真正的区分只体现在收不收得到信——这与 forgot-password 的口径一致。
 * - **风控分两层，必须都过**：
 *   1. *打分层* 在 `DrizzleAdapter.createUser`（历史 hard-purge / 可疑邮箱
 *      → 写 `riskTier`）。调 adapter 即继承。★注意其中的 IP 聚类分量依赖
 *      `next/headers` 的 `headers()`，取不到时静默降级（`adapter.ts` 的
 *      `catch {}`）→ `signupIpHash=null` → `ip_cluster` 不参与打分。
 *      故这一条**不保证**在本链路生效。
 *   2. *拒绝层* 在 `auth.ts` 的 signIn callback：一次性邮箱黑名单 +
 *      同 IP 24h 硬闸。★但那段只对 OAuth 生效——`provider === 'credentials'`
 *      在 auth.ts:256 直接 `return true`，整块 `if (account?.provider)` 走不到。
 *      故本路由**必须自己调**这三个守卫，否则 credentials 注册完全绕过
 *      反多重注册体系：同 IP 上限从 3/24h 变成 10/小时（240/天），差 80 倍。
 *   ★不要把「调了 adapter」当成「过了风控」——打分不等于拒绝，
 *   tier 2 仍有 25% AI 配额且允许付费（risk-tier.ts:151-159）。
 * - **密码单独落库**：适配器不接 `passwordHash`，故建号后再 update 写入。
 *   两步之间失败会留下一个无密码账号（等价于 OAuth-only），用户可用
 *   「忘记密码」补设，不会成为可登录的空壳。
 * - **不自动登录**：注册后要求显式登录，让 2FA / 可信设备等既有登录路径
 *   保持唯一入口，避免这里成为绕过它们的旁路。
 * - **不在此处发验证信**：发信由用户在设置页主动触发（限流在那一侧），
 *   注册链路只负责建号。避免注册接口被当成发信喷口。
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 与登录页一致的最小长度；再严的策略应集中到一处而非分散在各入口。 */
const MIN_PASSWORD_LENGTH = 8;

/** 极简邮箱形状校验：真正的有效性由「能否收到验证信」决定。 */
function looksLikeEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

export async function POST(request: NextRequest) {
  // ★与 signup 页同一道闸：页面用 CAN_SIGNUP 守门（on-prem 下 notFound），
  //   但 API 是独立入口——只关页面等于没关。on-prem 部署里账号由运维预置，
  //   开放自助注册会绕过这一约定。
  const { CAN_SIGNUP } = await import('@/lib/deployment-mode');
  if (!CAN_SIGNUP) {
    return NextResponse.json({ error: 'Signup is disabled' }, { status: 404 });
  }

  const clientIp = getClientIp(request);
  const rl = await checkRateLimitDistributed(
    `signup:${clientIp}`,
    RateLimitPresets.SIGNUP,
  );
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many signup attempts. Please try again later.' },
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
  const { email, password, name } = (body ?? {}) as {
    email?: unknown;
    password?: unknown;
    name?: unknown;
  };

  if (typeof email !== 'string' || !looksLikeEmail(email)) {
    return NextResponse.json({ error: 'A valid email is required' }, { status: 400 });
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
      { status: 400 },
    );
  }
  if (name !== undefined && typeof name !== 'string') {
    return NextResponse.json({ error: 'name must be a string' }, { status: 400 });
  }

  const lower = email.toLowerCase();

  // ★拒绝层守卫：与 auth.ts:319/352 同口径。这段在 OAuth 路径上由 signIn
  //   callback 执行，但 credentials 在 auth.ts:256 就 return true 走不到，
  //   故此处必须自己调——否则本路由是反多重注册体系的一个后门。
  const { isDisposableEmail } = await import('@/lib/email-disposable');
  const { checkSignupRateLimit } = await import('@/lib/signup-rate-limit');

  if (isDisposableEmail(lower)) {
    await recordSignupAttempt(clientIp, false);
    // 一律返回同形 200：区分「被拒」与「成功」会把黑名单变成探测接口。
    return NextResponse.json({ ok: true });
  }

  // 同 IP 24h 硬闸（OAuth 侧是 3 次）。与上面按小时的 RateLimitPresets.SIGNUP
  // 是两道不同粒度的闸，不可互相替代。
  if (!(await checkSignupRateLimit(clientIp))) {
    await recordSignupAttempt(clientIp, false);
    return NextResponse.json(
      { error: 'Too many signup attempts. Please try again later.' },
      { status: 429 },
    );
  }

  // ★邮箱枚举防护：已存在时返回与成功同形的 200。
  //   同时按 emailNormalized 查——否则 `a.b+x@gmail.com` 能绕开 `ab@gmail.com`
  //   的占用检查，建出一个登录时会与既有账号相撞的重复号。
  const normalized = normalizeEmail(lower);
  const existing = await db.query.users.findFirst({
    where: eq(users.email, lower),
    columns: { id: true },
  });
  const existingNormalized = normalized
    ? await db.query.users.findFirst({
        where: eq(users.emailNormalized, normalized),
        columns: { id: true },
      })
    : null;
  if (existing || existingNormalized) {
    return NextResponse.json({ ok: true });
  }

  // 适配器的 createUser 负责**打分层**：注册风险分层、IP 聚类、历史
  // hard-purge 计数、tier≥2 的 Slack 告警。拒绝层已在上面单独调过。
  const { DrizzleAdapter } = await import('@/db/adapter');
  const adapter = DrizzleAdapter(db);
  if (!adapter.createUser) {
    return NextResponse.json({ error: 'Signup unavailable' }, { status: 500 });
  }

  const created = await adapter.createUser({
    id: crypto.randomUUID(), // 适配器内部会重新生成，此处仅满足类型
    email: lower,
    emailVerified: null, // ★不预置已验证：必须走验证流程才解锁 AI
    name: typeof name === 'string' && name.trim() ? name.trim() : null,
    image: null,
  });

  const passwordHash = await hashPassword(password);
  await db
    .update(users)
    .set({ passwordHash })
    .where(eq(users.id, created.id));

  // ★signupIpHash 的补写：适配器在 createUser 里从 headers() 取，取不到则留 null
  //   （`catch {}` 静默降级）。此处用 isNull 条件补上，让本链路至少有一条
  //   稳定的 IP 记录——否则 `assessRegistrationRisk` 的 ip_cluster 分量会
  //   因 signupIpHash=null 而完全不参与打分。
  //
  //   ★两处取 IP 的优先级**恰好相反**：
  //     适配器  x-forwarded-for → x-real-ip → cf-connecting-ip
  //     此处    cf-connecting-ip → x-forwarded-for → x-real-ip
  //   CF 部署下 `x-forwarded-for` 首段客户端可伪造、`cf-connecting-ip` 才可信，
  //   所以**本处口径更准**。用 isNull 而非无条件覆盖是保守选择：不改动既有
  //   写入语义。若将来要统一，应改适配器的优先级而不是在这里盖写。
  if (clientIp) {
    await db
      .update(users)
      .set({ signupIpHash: hashIp(clientIp) })
      .where(and(eq(users.id, created.id), isNull(users.signupIpHash)));
  }

  // 记账成功注册：checkSignupRateLimit 靠这张表算同 IP 24h 次数，
  // 只记失败不记成功会让硬闸永远数不满、形同虚设。
  await recordSignupAttempt(clientIp, true);

  return NextResponse.json({ ok: true });
}
