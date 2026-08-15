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

import { and, eq, gt, lt } from 'drizzle-orm';

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
 * <p>签发前作废该邮箱既有的未过期码：否则同时存在多个有效码会让
 * 攻击面按码数量线性放大，也会让用户困惑于"哪个码是对的"。
 */
export async function issueCode(email: string, now: Date = new Date()): Promise<string> {
  const db = getDb();
  const normalized = email.toLowerCase().trim();

  await db.delete(twoFactorCodes).where(eq(twoFactorCodes.email, normalized));

  const code = generateCode();
  await db.insert(twoFactorCodes).values({
    id: crypto.randomUUID(),
    email: normalized,
    codeHash: hashCode(code),
    expires: new Date(now.getTime() + CODE_TTL_MINUTES * 60_000),
    attempts: 0,
    createdAt: now,
  });

  return code;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'NO_CODE' | 'EXPIRED' | 'TOO_MANY_ATTEMPTS' | 'MISMATCH' };

/**
 * 校验验证码。成功即消费掉（一次性）。
 *
 * <p>★失败时**不删除**记录，而是累加 attempts——删掉等于让攻击者
 * 每次猜错都能重新拿一个"干净"的计数器，限次形同虚设。
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

  if (row.attempts >= MAX_ATTEMPTS) {
    // 已达上限：直接作废，逼迫重新签发（重新签发会经过发信节流）。
    await db.delete(twoFactorCodes).where(eq(twoFactorCodes.id, row.id));
    return { ok: false, reason: 'TOO_MANY_ATTEMPTS' };
  }

  if (!safeEqualHex(row.codeHash, hashCode(code))) {
    await db
      .update(twoFactorCodes)
      .set({ attempts: row.attempts + 1 })
      .where(eq(twoFactorCodes.id, row.id));
    return { ok: false, reason: 'MISMATCH' };
  }

  // 一次性：验过即销毁，防重放。
  await db.delete(twoFactorCodes).where(eq(twoFactorCodes.id, row.id));
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
