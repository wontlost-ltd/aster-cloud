// 登录二次验证码的**安全属性**（issue #400）。
//
// ## 为什么必须用真 Postgres
//
// 这里守的三条都是**状态跨调用累积**的性质：
//   一次性（验过即销毁）、限次（attempts 累加）、签发即作废旧码。
// mock 掉 db 就等于在测 mock —— 上面每一条都依赖真实的行状态。
//
// ★这些不是"功能是否可用"，是"攻破成本是否成立"。6 位码只有 100 万种可能，
//   限次一旦失效，有效期内即可枚举。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { db } from '@/lib/prisma';
import { twoFactorCodes } from '@/db/schema';
import {
  MAX_ATTEMPTS,
  hasActiveCode,
  hashCode,
  issueCode,
  purgeExpiredCodes,
  verifyCode,
} from '@/lib/two-factor';

import { setupTestDb, teardownTestDb } from './setup-postgres';

const EMAIL = 'twofactor-probe@example.com';
const NOW = new Date('2026-08-15T12:00:00.000Z');
const later = (min: number) => new Date(NOW.getTime() + min * 60_000);

describe.skipIf(process.env.LICENSE_E2E !== '1')('二次验证码安全属性（issue #400）', () => {
  beforeAll(async () => {
    (process.env as Record<string, string>).NODE_ENV = 'test';
    process.env.DEPLOYMENT_MODE = 'saas';
    await setupTestDb();
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await db.delete(twoFactorCodes).where(eq(twoFactorCodes.email, EMAIL));
  });

  it('★明文码不落库——只存 sha256', async () => {
    // 只读 DB 泄露不应直接产出可用的登录凭据（与 password-reset-tokens 同一纪律）。
    const code = await issueCode(EMAIL, NOW);
    const [row] = await db
      .select()
      .from(twoFactorCodes)
      .where(eq(twoFactorCodes.email, EMAIL));

    expect(row.codeHash).not.toBe(code);
    expect(row.codeHash).toBe(hashCode(code));
    expect(row.codeHash).toHaveLength(64);
    // 兜底：整行序列化后不得出现明文码
    expect(JSON.stringify(row)).not.toContain(code);
  });

  it('★正确码验一次即失效（一次性，防重放）', async () => {
    const code = await issueCode(EMAIL, NOW);

    expect(await verifyCode(EMAIL, code, NOW)).toEqual({ ok: true });
    // 第二次用同一个码必须失败——否则截获一次即可重复登录
    expect(await verifyCode(EMAIL, code, NOW)).toEqual({ ok: false, reason: 'NO_CODE' });
  });

  it('★错误码累加 attempts 而不是删行——否则限次形同虚设', async () => {
    // 删行的话，攻击者每猜错一次都能拿到"干净"的计数器。
    const code = await issueCode(EMAIL, NOW);
    const wrong = code === '000000' ? '111111' : '000000';

    for (let i = 1; i <= 3; i++) {
      expect(await verifyCode(EMAIL, wrong, NOW)).toEqual({
        ok: false,
        reason: 'MISMATCH',
      });
      const [row] = await db
        .select()
        .from(twoFactorCodes)
        .where(eq(twoFactorCodes.email, EMAIL));
      expect(row.attempts, `第 ${i} 次猜错后计数`).toBe(i);
    }

    // 正确码此时仍然可用（还没到上限）
    expect(await verifyCode(EMAIL, code, NOW)).toEqual({ ok: true });
  });

  it('★达到上限后作废——即便随后给出正确码也不放行', async () => {
    const code = await issueCode(EMAIL, NOW);
    const wrong = code === '000000' ? '111111' : '000000';

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await verifyCode(EMAIL, wrong, NOW);
    }

    // 这一条是本用例的核心：限次必须**真的挡住**正确码，
    // 否则攻击者可以先耗尽计数再撞对，限次就只是装饰。
    const verdict = await verifyCode(EMAIL, code, NOW);
    expect(verdict.ok).toBe(false);
    expect(await hasActiveCode(EMAIL, NOW)).toBe(false);
  });

  it('★过期码不放行，且被清掉', async () => {
    const code = await issueCode(EMAIL, NOW);

    const verdict = await verifyCode(EMAIL, code, later(11)); // TTL=10min
    expect(verdict).toEqual({ ok: false, reason: 'EXPIRED' });
    expect(await hasActiveCode(EMAIL, later(11))).toBe(false);
  });

  it('★重新签发作废旧码——不得同时存在多个有效码', async () => {
    // 多码并存会让攻击面按码数量线性放大，也会让用户困惑于"哪个是对的"。
    const first = await issueCode(EMAIL, NOW);
    const second = await issueCode(EMAIL, NOW);

    expect(second).not.toBe(first); // 概率上几乎必然；相同则下一条断言仍成立
    expect(await verifyCode(EMAIL, first, NOW)).toEqual({
      ok: false,
      reason: 'MISMATCH',
    });

    const rows = await db
      .select()
      .from(twoFactorCodes)
      .where(eq(twoFactorCodes.email, EMAIL));
    expect(rows, '同一邮箱同时只应有一条有效码').toHaveLength(1);
  });

  it('hasActiveCode 用于发信节流——有效期内不重复发信', async () => {
    expect(await hasActiveCode(EMAIL, NOW)).toBe(false);
    await issueCode(EMAIL, NOW);
    expect(await hasActiveCode(EMAIL, NOW)).toBe(true);
    // 过期后不再算"活跃"，允许重新签发
    expect(await hasActiveCode(EMAIL, later(11))).toBe(false);
  });

  it('purgeExpiredCodes 只清过期的，不碰有效的', async () => {
    await issueCode(EMAIL, NOW);
    expect(await purgeExpiredCodes(NOW)).toBe(0);
    expect(await hasActiveCode(EMAIL, NOW)).toBe(true);

    expect(await purgeExpiredCodes(later(11))).toBe(1);
  });

  it('邮箱大小写/空格规范化——签发与校验口径一致', async () => {
    // 登录时 email 已 toLowerCase().trim()，这里确保两侧口径相同，
    // 否则用户用 "  Foo@Bar.com " 登录会永远验不过。
    const code = await issueCode('  TwoFactor-Probe@Example.COM  ', NOW);
    expect(await verifyCode(EMAIL, code, NOW)).toEqual({ ok: true });
  });
});
