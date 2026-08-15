/**
 * 登录二次验证：邮件 6 位一次性验证码（issue #400）。
 *
 * <h2>为什么是「一次提交收齐三个字段」而不是半登录态</h2>
 *
 * Auth.js v5 的 `authorize()` 是**一次性**的：要么返回 user（登录成功），
 * 要么返回 null（失败），**没有「密码对了但还要第二步」这个中间态**。
 *
 * 两种做法：
 *   A. 前端分两屏，但只在第二屏一次提交 email+password+code —— 本实现
 *   B. 引入半登录 token，密码通过后换一个短时凭据，第二步再换正式 session
 *
 * 选 A 的理由：B 的**半登录态本身是新的攻击面**（那个 token 等价于
 * "已过密码关"的凭据，泄露即绕过第一因子），需要单独一轮安全审计。
 * A 不新增任何凭据类型，代价只是"密码错"要到第二屏才报出来。
 *
 * <h2>三条安全约束</h2>
 *
 * 1. **存 sha256(code) 不存明文** —— 与 password-reset-tokens.ts 同一纪律：
 *    只读的 DB 泄露不应直接产出可用的登录凭据。
 * 2. **限次** —— 6 位码只有 100 万种可能，不限次则可在有效期内枚举。
 * 3. **恒定时间比较** —— 避免按字节短路的计时侧信道。
 */

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

import { and, eq, gt, lt, sql } from 'drizzle-orm';

import { getDb } from '@/db';
import { twoFactorCodes } from '@/db/schema';

/** 验证码有效期（分钟）。短到降低被截获后可用窗口，长到够用户切到邮箱。 */
export const CODE_TTL_MINUTES = 10;

/**
 * 单个验证码允许的错误次数上限。
 *
 * ★5 次 × 100 万分之一 ≈ 可忽略。放宽到几十次就开始有意义地削弱 6 位码——
 * 这不是"用户体验参数"，是安全参数。
 */
export const MAX_ATTEMPTS = 5;

/**
 * 限次窗口长度（分钟）。窗口内的猜错与发信次数**跨码累计**。
 *
 * ★这是修复审查发现的 Critical 的核心：只按「码」限次，攻击者
 * 猜满即重新签发就能拿到干净计数器；按「邮箱 + 窗口」限次才有意义。
 */
export const WINDOW_MINUTES = 60;

/** 窗口内允许的累计猜错次数（跨码）。 */
export const MAX_WINDOW_ATTEMPTS = 15;

/** 窗口内允许签发的验证码数量——发信节流的真正锚点。 */
export const MAX_WINDOW_ISSUED = 5;

/** sha256(code) 的小写 hex —— 持久化的形态。 */
export function hashCode(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * 生成 6 位数字码。
 *
 * ★用 `randomInt`（CSPRNG）而不是 `Math.random()`：后者可预测，
 * 拿到几个历史码就能推出后续码。
 * 保留前导零（`000123` 也是合法码），故用 padStart 而非数值范围。
 */
export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** 恒定时间比较两个等长 hex 串。 */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * 为某邮箱签发一个新验证码，返回**明文码**（仅用于发信，不得落库/记日志）。
 *
 * <p>同一邮箱**至多一条**码行（email 上有 UNIQUE 索引 + upsert）：
 * 多码并存会让攻击面按码数量线性放大，也会让 verifyCode 的 findFirst
 * 任选一行、导致用户手里最新的码验不过。
 *
 * <p>★窗口计数（windowAttempts / windowIssued）**随签发继承而非重置**——
 * 这是限次真正生效的前提，详见常量 WINDOW_MINUTES 的注释。
 *
 * <p>返回 WINDOW_EXCEEDED 时调用方**不应发信**，并应向用户提示稍后再试。
 */
export async function issueCode(
  email: string,
  now: Date = new Date(),
): Promise<{ ok: true; code: string } | { ok: false; reason: 'WINDOW_EXCEEDED' }> {
  const db = getDb();
  const normalized = email.toLowerCase().trim();

  // 读既有行以继承窗口计数。★窗口不随签发重置，正是这一点堵住了
  //   "猜满 5 次 → 重新签发 → 计数归零"的无限循环。
  const prev = await db.query.twoFactorCodes.findFirst({
    where: eq(twoFactorCodes.email, normalized),
  });

  const windowAlive =
    prev?.windowStartedAt != null &&
    now.getTime() - prev.windowStartedAt.getTime() < WINDOW_MINUTES * 60_000;

  const windowStartedAt = windowAlive ? prev!.windowStartedAt! : now;
  const windowAttempts = windowAlive ? prev!.windowAttempts : 0;
  const windowIssued = (windowAlive ? prev!.windowIssued : 0) + 1;

  // 窗口内累计猜错已超限 → 拒绝再签发（否则限次形同虚设）。
  if (windowAlive && windowAttempts >= MAX_WINDOW_ATTEMPTS) {
    return { ok: false, reason: 'WINDOW_EXCEEDED' };
  }
  // 窗口内发信次数上限 → 防止登录接口成为邮件轰炸放大器。
  if (windowAlive && windowIssued > MAX_WINDOW_ISSUED) {
    return { ok: false, reason: 'WINDOW_EXCEEDED' };
  }

  const code = generateCode();
  // ★单条原子 upsert 取代 delete+insert：email 上有 UNIQUE 索引，
  //   并发时后到者走 onConflictDoUpdate 而不是插出第二行。
  await db
    .insert(twoFactorCodes)
    .values({
      id: crypto.randomUUID(),
      email: normalized,
      codeHash: hashCode(code),
      expires: new Date(now.getTime() + CODE_TTL_MINUTES * 60_000),
      attempts: 0,
      windowAttempts,
      windowStartedAt,
      windowIssued,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: twoFactorCodes.email,
      set: {
        codeHash: hashCode(code),
        expires: new Date(now.getTime() + CODE_TTL_MINUTES * 60_000),
        attempts: 0,
        windowAttempts,
        windowStartedAt,
        windowIssued,
      },
    });

  return { ok: true, code };
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'NO_CODE' | 'EXPIRED' | 'TOO_MANY_ATTEMPTS' | 'MISMATCH' };

/**
 * 校验验证码。成功即消费掉（一次性）。
 *
 * <p>★失败时**不删除**记录，而是原子自增 attempts + windowAttempts。
 * 删行等于让攻击者重新拿一个"干净"的计数器——这一点在初版实现里
 * 只做到了一半（猜错时不删，但**达上限时删**），被安全审查抓出为 Critical：
 * 删行后 hasActiveCode 失效 → 下次提交空码即签发新码、计数归零 → 无限重开。
 * 现在达上限也保留行，由窗口计时自然失效。
 */
export async function verifyCode(
  email: string,
  code: string,
  now: Date = new Date(),
): Promise<VerifyResult> {
  const db = getDb();
  const normalized = email.toLowerCase().trim();

  const row = await db.query.twoFactorCodes.findFirst({
    where: eq(twoFactorCodes.email, normalized),
  });

  if (!row) return { ok: false, reason: 'NO_CODE' };

  if (row.expires.getTime() <= now.getTime()) {
    await db.delete(twoFactorCodes).where(eq(twoFactorCodes.id, row.id));
    return { ok: false, reason: 'EXPIRED' };
  }

  // ★达上限**不删行**（审查发现的 Critical）：删掉会让 hasActiveCode 失效，
  //   攻击者下次提交空码即可拿到全新计数器。留着行，并让窗口计数持续生效。
  if (row.attempts >= MAX_ATTEMPTS || row.windowAttempts >= MAX_WINDOW_ATTEMPTS) {
    return { ok: false, reason: 'TOO_MANY_ATTEMPTS' };
  }

  if (!safeEqualHex(row.codeHash, hashCode(code))) {
    // ★单条原子 SQL 自增，并带 attempts 上限条件（审查发现的 High）：
    //   原本的 SELECT→比较→UPDATE SET attempts = row.attempts + 1 是
    //   读改写竞态——并发 N 个请求全读到 0、全写 1，单码可吸收数百次猜测。
    const bumped = await db
      .update(twoFactorCodes)
      .set({
        attempts: sql`${twoFactorCodes.attempts} + 1`,
        windowAttempts: sql`${twoFactorCodes.windowAttempts} + 1`,
      })
      .where(
        and(eq(twoFactorCodes.id, row.id), lt(twoFactorCodes.attempts, MAX_ATTEMPTS)),
      )
      .returning({ attempts: twoFactorCodes.attempts });

    // 0 行返回 = 并发下别的请求已把计数推到上限 → 按超限处理，不当作普通错码。
    if (bumped.length === 0) return { ok: false, reason: 'TOO_MANY_ATTEMPTS' };
    return { ok: false, reason: 'MISMATCH' };
  }

  // 一次性：验过即作废，防重放。
  //
  // ★用「把 codeHash 置为不可能匹配的值 + 立刻过期」而不是删行：
  //   删行会连窗口计数一起抹掉，等于给了攻击者一条"猜对一次即重置限次"的
  //   通路（登录成功后窗口清零，下一轮又是满额）。行留着，让 windowAttempts
  //   继续按时间窗自然失效。
  //   codeHash 置空串：safeEqualHex 的长度检查会让它对任何 64 位 hash 都不等，
  //   且 expires 设为已过期，双保险。
  await db
    .update(twoFactorCodes)
    .set({ codeHash: '', expires: new Date(now.getTime() - 1) })
    .where(eq(twoFactorCodes.id, row.id));
  return { ok: true };
}

/**
 * 清理过期码。由留存/清理 cron 调用即可，不清也不会失效（校验时按 expires 判定），
 * 只是行会堆积。
 */
export async function purgeExpiredCodes(now: Date = new Date()): Promise<number> {
  const db = getDb();
  const rows = await db
    .delete(twoFactorCodes)
    .where(lt(twoFactorCodes.expires, now))
    .returning({ id: twoFactorCodes.id });
  return rows.length;
}

/**
 * 该邮箱当前是否有未过期的验证码——用于发信节流：
 * 已经有一个有效码时不重复发信，避免被当成邮件轰炸的放大器。
 */
export async function hasActiveCode(email: string, now: Date = new Date()): Promise<boolean> {
  const db = getDb();
  const row = await db.query.twoFactorCodes.findFirst({
    where: and(
      eq(twoFactorCodes.email, email.toLowerCase().trim()),
      gt(twoFactorCodes.expires, now),
    ),
  });
  return Boolean(row);
}
