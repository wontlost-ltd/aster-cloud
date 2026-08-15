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
  MAX_WINDOW_ATTEMPTS,
  MAX_WINDOW_ISSUED,
  hasActiveCode,
  hashCode,
  issueCode,
  purgeExpiredCodes,
  verifyCode,
} from '@/lib/two-factor';

import { cleanupTestDb, setupTestDb, teardownTestDb } from './setup-postgres';

const EMAIL = 'twofactor-probe@example.com';
/** ★第二个身份：单租户测试永远抓不到跨租户 bug（审查实证）。 */
const VICTIM = 'twofactor-victim@example.com';

/** issueCode 现在返回 {ok, code}；测试里断言成功并取码。 */
async function issue(email: string, now: Date): Promise<string> {
  const r = await issueCode(email, now);
  if (!r.ok) throw new Error(`issueCode 意外被限流: ${r.reason}`);
  return r.code;
}
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
    // ★统一清库：两个套件共用 TwoFactorCode/TrustedDevice，
    //   只删自己的邮箱会让另一个套件的残留行造成跨文件污染。
    await cleanupTestDb();
    for (const e of [EMAIL, VICTIM]) {
      await db.delete(twoFactorCodes).where(eq(twoFactorCodes.email, e));
    }
  });

  it('★明文码不落库——只存 sha256', async () => {
    // 只读 DB 泄露不应直接产出可用的登录凭据（与 password-reset-tokens 同一纪律）。
    const code = await issue(EMAIL, NOW);
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
    const code = await issue(EMAIL, NOW);

    expect(await verifyCode(EMAIL, code, NOW)).toEqual({ ok: true });
    // 第二次用同一个码必须失败——否则截获一次即可重复登录。
    // ★断言的是「不放行」这个**性质**，不钉死具体 reason：
    //   消费方式从「删行」改为「标记作废并立即过期」后 reason 由
    //   NO_CODE 变成 EXPIRED，而安全性质完全不变。钉死 reason 会让
    //   一次合理的实现调整变成红灯，久而久之被人删掉。
    const replay = await verifyCode(EMAIL, code, NOW);
    expect(replay.ok, '同一个码被第二次使用').toBe(false);
  });

  it('★错误码累加 attempts 而不是删行——否则限次形同虚设', async () => {
    // 删行的话，攻击者每猜错一次都能拿到"干净"的计数器。
    const code = await issue(EMAIL, NOW);
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
    const code = await issue(EMAIL, NOW);
    const wrong = code === '000000' ? '111111' : '000000';

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await verifyCode(EMAIL, wrong, NOW);
    }

    // 这一条是本用例的核心：限次必须**真的挡住**正确码，
    // 否则攻击者可以先耗尽计数再撞对，限次就只是装饰。
    const verdict = await verifyCode(EMAIL, code, NOW);
    expect(verdict.ok, '达上限后正确码仍被放行=限次是装饰').toBe(false);
    // ★这里**不再**断言 hasActiveCode 为 false：现在达上限刻意**保留行**，
    //   正是为了让攻击者无法通过"删行→重新签发"拿到干净计数器（Critical 1）。
    //   行还在、码还没过期，所以 hasActiveCode 为 true 是**正确**行为。
    //   真正要守的是下一行：签发必须被窗口拦住。
    const reissue = await issueCode(EMAIL, NOW);
    if (reissue.ok) {
      const [row] = await db
        .select()
        .from(twoFactorCodes)
        .where(eq(twoFactorCodes.email, EMAIL));
      expect(row.windowAttempts, '重新签发把窗口计数清零了').toBeGreaterThanOrEqual(
        MAX_ATTEMPTS,
      );
    }
  });

  it('★过期码不放行，且被清掉', async () => {
    const code = await issue(EMAIL, NOW);

    const verdict = await verifyCode(EMAIL, code, later(11)); // TTL=10min
    expect(verdict).toEqual({ ok: false, reason: 'EXPIRED' });
    expect(await hasActiveCode(EMAIL, later(11))).toBe(false);
  });

  it('★重新签发作废旧码——不得同时存在多个有效码', async () => {
    // 多码并存会让攻击面按码数量线性放大，也会让用户困惑于"哪个是对的"。
    const first = await issue(EMAIL, NOW);
    const second = await issue(EMAIL, NOW);

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
    await issue(EMAIL, NOW);
    expect(await hasActiveCode(EMAIL, NOW)).toBe(true);
    // 过期后不再算"活跃"，允许重新签发
    expect(await hasActiveCode(EMAIL, later(11))).toBe(false);
  });

  it('purgeExpiredCodes 只清过期的，不碰有效的', async () => {
    await issue(EMAIL, NOW);
    expect(await purgeExpiredCodes(NOW)).toBe(0);
    expect(await hasActiveCode(EMAIL, NOW)).toBe(true);

    expect(await purgeExpiredCodes(later(11))).toBe(1);
  });

  // ── 以下五条针对独立审查发现的漏洞（每条都对应一个曾经存活的变异）──

  it('★跨账户：A 的码不得通过 B 的验证（M8）', async () => {
    // 审查实测：verifyCode 丢掉 email 过滤后，攻击者的码能通过一个
    // **根本没有码**的受害者的验证，而当时 9/9 全绿——因为整个套件
    // 只有一个 EMAIL 常量。单租户测试永远抓不到跨租户 bug。
    const attackerCode = await issue(EMAIL, NOW);

    expect(await verifyCode(VICTIM, attackerCode, NOW)).toEqual({
      ok: false,
      reason: 'NO_CODE',
    });
    // 受害者自己的码不受影响
    const victimCode = await issue(VICTIM, NOW);
    expect(await verifyCode(VICTIM, victimCode, NOW)).toEqual({ ok: true });
  });

  it('★限次不可通过重新签发重置（Critical 1）', async () => {
    // 这是初版最严重的漏洞：达上限即删行 → hasActiveCode 失效 →
    // 下次提交空码即签发新码、计数归零 → 无限重开，约 20 万轮 63% 命中。
    const code = await issue(EMAIL, NOW);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < MAX_ATTEMPTS; i++) await verifyCode(EMAIL, wrong, NOW);

    // 重新签发：窗口计数必须**继承**而非归零
    const second = await issueCode(EMAIL, NOW);
    if (second.ok) {
      const [row] = await db
        .select()
        .from(twoFactorCodes)
        .where(eq(twoFactorCodes.email, EMAIL));
      expect(row.windowAttempts, '窗口计数被重置=限次形同虚设').toBeGreaterThanOrEqual(
        MAX_ATTEMPTS,
      );
    }

    // 继续猜错直到窗口耗尽，签发必须被拒
    for (let i = 0; i < MAX_WINDOW_ATTEMPTS + 5; i++) {
      await verifyCode(EMAIL, wrong, NOW);
      const r = await issueCode(EMAIL, NOW);
      if (!r.ok) {
        expect(r.reason).toBe('WINDOW_EXCEEDED');
        return; // 达到预期：窗口生效
      }
    }
    throw new Error('★窗口限次从未生效——限次可被无限重置');
  });

  it('★发信次数有窗口上限——登录不得成为邮件轰炸放大器（High）', async () => {
    let issued = 0;
    for (let i = 0; i < MAX_WINDOW_ISSUED + 3; i++) {
      const r = await issueCode(EMAIL, NOW);
      if (r.ok) issued++;
      else {
        expect(r.reason).toBe('WINDOW_EXCEEDED');
        break;
      }
      // 让下一轮能再签发（模拟"码被用掉/过期"）
      await db
        .update(twoFactorCodes)
        .set({ expires: new Date(NOW.getTime() - 1) })
        .where(eq(twoFactorCodes.email, EMAIL));
    }
    expect(issued, '窗口内签发次数无上限').toBeLessThanOrEqual(MAX_WINDOW_ISSUED);
  });

  it('★全 hash 敏感——只比前缀会被碰撞攻破（M2）', async () => {
    // 审查暴力找到真实碰撞：081779 与 089678 的 sha256 前 8 位相同。
    // 若比较被截断，后者能通过前者的验证。
    const a = '081779';
    const b = '089678';
    expect(hashCode(a).slice(0, 8), '前置条件：这两个码前 8 位 hash 相同').toBe(
      hashCode(b).slice(0, 8),
    );
    expect(hashCode(a)).not.toBe(hashCode(b));

    await db.insert(twoFactorCodes).values({
      id: crypto.randomUUID(),
      email: EMAIL,
      codeHash: hashCode(a),
      expires: new Date(NOW.getTime() + 600_000),
      attempts: 0,
      windowAttempts: 0,
      windowStartedAt: NOW,
      windowIssued: 1,
      createdAt: NOW,
    });

    expect(await verifyCode(EMAIL, b, NOW)).toEqual({ ok: false, reason: 'MISMATCH' });
  });

  it('★验证成功不得重置窗口计数（否则猜对一次即清零限次）', async () => {
    const code = await issue(EMAIL, NOW);
    const wrong = code === '000000' ? '111111' : '000000';
    await verifyCode(EMAIL, wrong, NOW);
    await verifyCode(EMAIL, wrong, NOW);

    expect(await verifyCode(EMAIL, code, NOW)).toEqual({ ok: true });

    const [row] = await db
      .select()
      .from(twoFactorCodes)
      .where(eq(twoFactorCodes.email, EMAIL));
    expect(row, '成功后行被删=窗口计数丢失').toBeDefined();
    expect(row.windowAttempts, '成功验证清零了窗口计数').toBeGreaterThanOrEqual(2);
  });

  it('邮箱大小写/空格规范化——签发与校验口径一致', async () => {
    // 登录时 email 已 toLowerCase().trim()，这里确保两侧口径相同，
    // 否则用户用 "  Foo@Bar.com " 登录会永远验不过。
    const code = await issue('  TwoFactor-Probe@Example.COM  ', NOW);
    expect(await verifyCode(EMAIL, code, NOW)).toEqual({ ok: true });
  });
});
