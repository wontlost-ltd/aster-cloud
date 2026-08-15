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
  CODE_TTL_MINUTES,
  MAX_ATTEMPTS,
  MAX_WINDOW_ATTEMPTS,
  MAX_WINDOW_ISSUED,
  WINDOW_MINUTES,
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

    // ★回收条件从「码过期」收紧为「码过期 **且** 窗口过期」（复审 High）：
    //   窗口计数就存在这一行上，只按码过期回收等于给攻击者一条
    //   "等 cron 跑一次就重置限次"的通路。
    //   故 +11 分钟（码过期、窗口未过期）时**不该**回收——
    //   这不是放宽，是把删除时机推迟到窗口自然失效之后。
    expect(await purgeExpiredCodes(later(11))).toBe(0);
    expect(await purgeExpiredCodes(later(WINDOW_MINUTES + 5))).toBe(1);
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

  // 复审发现的两个 High：窗口计数寄生在「会被删掉的码行」上，且上限判定
  // 用应用层快照而非数据库原子语句。两者都能让限次退化成摆设。
  // 这两条测试直接复刻审计者实测出的攻击序列，而不是测"函数返回了对的枚举"。
  describe('★窗口限次不可被重置或绕过（复审 High）', () => {
    it('★码过期不重置窗口——猜满→等过期→再猜，累计仍受 15 次上限约束', async () => {
      const email = 'window-expiry-probe@example.com';
      const t0 = new Date('2026-08-15T10:00:00Z');

      // 第 1 轮：签发并猜错 5 次，打满单码上限。
      const r1 = await issueCode(email, t0);
      expect(r1.ok).toBe(true);
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        await verifyCode(email, '000000', t0);
      }

      // 等到码过期（TTL 10 分钟）但**窗口仍在**（60 分钟）。
      // 攻击者在此提交任意码触发 EXPIRED 分支——旧实现会在这里删行。
      const tExpired = new Date(t0.getTime() + 11 * 60_000);
      expect(await verifyCode(email, '000000', tExpired)).toEqual({
        ok: false,
        reason: 'EXPIRED',
      });

      // ★关键断言：窗口计数必须幸存。若 EXPIRED 分支删了行，
      //   这里会读到 undefined，攻击者即可拿到全新计数器。
      const row = await db.query.twoFactorCodes.findFirst({
        where: eq(twoFactorCodes.email, email),
      });
      expect(row, 'EXPIRED 分支删了行 → 窗口计数被清零').toBeTruthy();
      expect(row!.windowAttempts).toBe(MAX_ATTEMPTS);

      // 第 2 轮：重新签发后继续猜，累计到 15 次即应被窗口上限拒绝。
      const r2 = await issueCode(email, tExpired);
      expect(r2.ok).toBe(true);
      let windowRejections = 0;
      for (let i = 0; i < 20; i++) {
        const res = await verifyCode(email, '000000', tExpired);
        if (!res.ok && res.reason === 'TOO_MANY_ATTEMPTS') windowRejections++;
      }
      // 若窗口被重置，这 20 次里会有大量 MISMATCH（即"猜测预算"被续杯）。
      expect(windowRejections, '窗口上限未生效——猜测预算被无限续杯').toBeGreaterThan(0);

      const after = await db.query.twoFactorCodes.findFirst({
        where: eq(twoFactorCodes.email, email),
      });
      expect(after!.windowAttempts).toBeLessThanOrEqual(MAX_WINDOW_ATTEMPTS);
    });

    it('★purgeExpiredCodes 不得清理窗口仍活跃的行', async () => {
      const email = 'window-purge-probe@example.com';
      const t0 = new Date('2026-08-15T12:00:00Z');
      await issueCode(email, t0);
      await verifyCode(email, '000000', t0); // 留下 windowAttempts=1

      // 码已过期但窗口未过期 → cron 不应删它，否则等于定时重置限次。
      const tAfterTtl = new Date(t0.getTime() + 11 * 60_000);
      await purgeExpiredCodes(tAfterTtl);
      const survived = await db.query.twoFactorCodes.findFirst({
        where: eq(twoFactorCodes.email, email),
      });
      expect(survived, 'cron 删掉了窗口仍活跃的行 → 限次被定时清零').toBeTruthy();

      // 窗口也过期后才允许回收，避免表无限增长。
      const tAfterWindow = new Date(t0.getTime() + (WINDOW_MINUTES + 5) * 60_000);
      await purgeExpiredCodes(tAfterWindow);
      const gone = await db.query.twoFactorCodes.findFirst({
        where: eq(twoFactorCodes.email, email),
      });
      expect(gone, '窗口过期后仍未回收 → 表会无限增长').toBeFalsy();
    });

    it('★并发签发不得突破 MAX_WINDOW_ISSUED（发信放大器）', async () => {
      const email = 'window-race-probe@example.com';
      const t0 = new Date('2026-08-15T14:00:00Z');

      // 48 个并发请求同时打进来。读改写实现下它们会各自读到旧值、
      // 全部通过应用层预检，实测发出 48 封邮件（约 10 倍放大）。
      const results = await Promise.all(
        Array.from({ length: 48 }, () => issueCode(email, t0)),
      );
      const issued = results.filter((r) => r.ok).length;

      // ★断言"成功签发数"而不是"计数器的值"：邮件是按前者发的。
      expect(
        issued,
        `并发签发放大：成功 ${issued} 次，上限应为 ${MAX_WINDOW_ISSUED}`,
      ).toBeLessThanOrEqual(MAX_WINDOW_ISSUED);

      const row = await db.query.twoFactorCodes.findFirst({
        where: eq(twoFactorCodes.email, email),
      });
      expect(row!.windowIssued).toBeLessThanOrEqual(MAX_WINDOW_ISSUED);
    });
  });

  it('★猜错满窗口上限后，不得再签发新码（此前无任何测试锁住）', async () => {
    // 两位独立审查都指出：setWhere 只约束 windowIssued，**不含
    // windowAttempts**，故"窗口内猜错 15 次后拒绝再签发"这条防线
    // 完全由 issueCode 顶部那个应用层 if 承担。
    // 实测把该 if 改成 `if (false && ...)` → 17/17 仍全绿，
    // 说明它当时是**裸奔**的：谁把它当冗余删掉都不会有红灯。本用例就是那道红灯。
    const email = 'window-attempts-gate@example.com';
    const t0 = new Date('2026-08-15T16:00:00Z');

    // 攻击者用尽窗口猜错预算：每码 5 次，签发 3 次 → 15 次。
    let guesses = 0;
    for (let round = 0; round < 3; round++) {
      const r = await issueCode(email, t0);
      expect(r.ok, `第 ${round + 1} 次签发不该被拒`).toBe(true);
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        const v = await verifyCode(email, '000000', t0);
        if (!v.ok && v.reason === 'MISMATCH') guesses++;
      }
    }
    expect(guesses).toBe(MAX_WINDOW_ATTEMPTS);

    // ★断言攻击者**实际拿不到新码**（可观测后果），而不是断言计数器读数——
    //   计数器可能因并发虚高，但"能不能再拿到一次猜测机会"才是安全属性。
    const blocked = await issueCode(email, t0);
    expect(blocked.ok, '猜满窗口上限后仍能签发新码 → 猜测预算可无限续杯').toBe(false);
  });

  it('★安全常量不得被静默放宽（自指陷阱）', () => {
    // 假绿猎手实测：把 MAX_WINDOW_ISSUED 从 5 改成 500（邮件轰炸放大 100 倍），
    // 18/18 依然全绿——因为其它用例都 `import` 这个常量再拿它当断言上界，
    // 改常量时**靶子跟着一起移动**。这类变异改一个数字即可，且无声。
    // 故本用例用**字面量**钉死，不引用被测模块的值。
    // 注释已声明「这不是用户体验参数，是安全参数」，这里是那句话的执行点。
    expect(MAX_ATTEMPTS, '单码猜错上限').toBe(5);
    expect(MAX_WINDOW_ATTEMPTS, '窗口内累计猜错上限').toBe(15);
    expect(MAX_WINDOW_ISSUED, '窗口内发信上限').toBe(5);
    expect(WINDOW_MINUTES, '限次窗口长度(分钟)').toBe(60);
    expect(CODE_TTL_MINUTES, '验证码有效期(分钟)').toBe(10);
  });

  it('★窗口起点不得随签发推移（否则窗口永不结束=限次永不生效）', async () => {
    // 假绿猎手 M3：把 windowStartedAt 的 CASE 改成恒等于 now（滑动窗口），
    // 17/17 全绿。原因是此前所有用例的时间点都塌缩在同一个窗口内
    // （t0 或 +11min），看不出「窗口起点是否被推移」。
    // 窗口起点每次签发都推到 now → windowFloor 判定永远为真 → 窗口永不结束。
    const email = 'window-anchor-probe@example.com';
    const t0 = new Date('2026-08-15T18:00:00Z');
    await issueCode(email, t0);
    const first = await db.query.twoFactorCodes.findFirst({
      where: eq(twoFactorCodes.email, email),
    });

    // 窗口内的第二次签发（+30min，仍在 60min 窗口内）。
    await issueCode(email, new Date(t0.getTime() + 30 * 60_000));
    const second = await db.query.twoFactorCodes.findFirst({
      where: eq(twoFactorCodes.email, email),
    });

    expect(
      second!.windowStartedAt!.getTime(),
      '窗口起点被推移 → 窗口永不自然结束 → 限次形同虚设',
    ).toBe(first!.windowStartedAt!.getTime());
  });

  it('★并发校验不得突破单码 attempts 上限（原子守卫的唯一覆盖）', async () => {
    // 假绿猎手 M10：删掉自增 WHERE 里的 lt(attempts, MAX_ATTEMPTS) 后仍 17/17 全绿——
    // 此前**没有任何用例并发调用 verifyCode**，:238 的 bumped.length===0
    // 分支从未被执行到。注释声称它挡住「并发全读到 0、全写 1」，但无证据。
    const email = 'verify-race-probe@example.com';
    const t0 = new Date('2026-08-15T19:00:00Z');
    const r = await issueCode(email, t0);
    expect(r.ok).toBe(true);

    const results = await Promise.all(
      Array.from({ length: 48 }, () => verifyCode(email, '000000', t0)),
    );
    const mismatches = results.filter((x) => !x.ok && x.reason === 'MISMATCH').length;

    // ★断言"攻击者实际拿到的有效猜测次数"，而不是计数器读数。
    expect(mismatches, `并发猜测突破单码上限：${mismatches} 次 > ${MAX_ATTEMPTS}`)
      .toBeLessThanOrEqual(MAX_ATTEMPTS);
  });

  it('★purge 的窗口保留期必须是整个窗口（边界两侧各探一次）', async () => {
    // 假绿猎手 M14：把 windowCutoff 从 60min 缩到 11min，17/17 全绿——
    // 因为此前只探 +11min 与 +65min 两点，任何落在 (11, 60] 的 cutoff 都通过。
    // 单点采样冒充区间：必须在 cap-1 / cap+1 两侧各钉一次。
    const email = 'purge-boundary-probe@example.com';
    const t0 = new Date('2026-08-15T20:00:00Z');
    await issueCode(email, t0);
    await verifyCode(email, '000000', t0);

    expect(
      await purgeExpiredCodes(new Date(t0.getTime() + (WINDOW_MINUTES - 1) * 60_000)),
      '窗口尚未结束(59min)就回收 → 限次被提前清零',
    ).toBe(0);
    expect(
      await purgeExpiredCodes(new Date(t0.getTime() + (WINDOW_MINUTES + 1) * 60_000)),
      '窗口已结束(61min)仍不回收 → 表无限增长',
    ).toBe(1);
  });

});
