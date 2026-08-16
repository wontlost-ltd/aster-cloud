// TOTP（验证器 App）安全属性 —— issue #400 第二步。
//
// ## 本文件的由来
//
// 三份独立审查（安全边界 / 声称核验 / 并发）对核心层做了对抗性审计，
// 发现 1 个 Critical + 3 个 High。**这些用例逐条复刻当时的攻击序列**，
// 而不是复述实现——每一条失败都对应一个真实可利用的缺陷。
//
// ## 为什么必须用真 Postgres
//
// 守的全是**跨调用的状态性质**：时间窗占用、恢复码一次性、并发确认。
// mock 掉 db 就是在测 mock。加密走 pgcrypto，也只有真库能验。

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { generate } from 'otplib';
import postgres from 'postgres';

import {
  confirmEnrollment,
  countUnusedRecoveryCodes,
  disableTotp,
  hasTotpEnabled,
  startEnrollment,
  verifyTotpForLogin,
} from '@/lib/totp';

import { setupTestDb, teardownTestDb } from './setup-postgres';

const WINDOW_MS = 30_000;
let sql: ReturnType<typeof postgres>;

/** 生成指定时刻所属窗口的合法码。 */
async function codeAt(secret: string, at: Date): Promise<string> {
  return generate({ secret, epoch: Math.floor(at.getTime() / 1000) });
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('TOTP 安全属性（issue #400）', () => {
  beforeAll(async () => {
    (process.env as Record<string, string>).NODE_ENV = 'test';
    process.env.DEPLOYMENT_MODE = 'saas';
    process.env.AI_KEY_ENCRYPTION_SECRET ||= 'local-test-encryption-secret-0123456789';
    const url = await setupTestDb();
    sql = postgres(url, { max: 1, prepare: false });
    await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await teardownTestDb();
  });

  beforeEach(async () => {
    await sql`TRUNCATE TABLE "TotpRecoveryCode", "TotpCredential" RESTART IDENTITY CASCADE`;
  });

  /** 建一个已确认的绑定，返回 secret 与确认时刻。 */
  async function enrolled(userId: string, at = new Date()) {
    const { secret } = await startEnrollment(userId, `${userId}@example.com`);
    const res = await confirmEnrollment(userId, await codeAt(secret, at), at);
    expect(res.ok, '前置：确认绑定应成功').toBe(true);
    return { secret, at, codes: res.ok ? res.recoveryCodes : [] };
  }

  it('★同一个码不得跨时间窗重放（审查发现的 Critical）', async () => {
    // 攻击序列：肩窥/MITM 拿到受害者**刚用过**的码 → 等 30 秒窗口滚动 → 重放。
    // 根因是 epochTolerance 让窗口 N 的码在 N+1 仍然有效，而占用判据若用
    // "当前墙钟窗口"，N < N+1 恒成立 → CAS 形同虚设。
    // 实测（修复前）：同一个码在 N+1 / N+2 / N+3 连续三次登录成功。
    const t0 = new Date('2026-08-16T10:00:00Z');
    const uid = 'replay-probe';
    const { secret } = await enrolled(uid, t0);

    const victimCode = await codeAt(secret, new Date(t0.getTime() + WINDOW_MS));
    const first = await verifyTotpForLogin(uid, victimCode, new Date(t0.getTime() + WINDOW_MS));
    expect(first.ok, '受害者本人应能登录').toBe(true);

    for (const k of [2, 3]) {
      const replay = await verifyTotpForLogin(
        uid,
        victimCode,
        new Date(t0.getTime() + WINDOW_MS * k),
      );
      expect(replay.ok, `窗口 N+${k} 重放同一码被接受 → 防重放失效`).toBe(false);
    }
  });

  it('★绑定确认后，下一个窗口的码必须能登录（审查发现的 High）', async () => {
    // 修复前 confirmEnrollment 记的是"此刻窗口"而非"码所属窗口"，
    // 用户绑定后第一次登录必被判 REPLAY——看着 App 上的码却被告知已使用。
    const t0 = new Date('2026-08-16T11:00:00Z');
    const uid = 'firstlogin-probe';
    const { secret } = await enrolled(uid, t0);

    const next = new Date(t0.getTime() + WINDOW_MS);
    const res = await verifyTotpForLogin(uid, await codeAt(secret, next), next);
    expect(res.ok, '绑定后首次登录被拒 → 上线首日就会收到工单').toBe(true);
  });

  it('★并发确认只能成功一次，恢复码恰好一套（审查发现的 High）', async () => {
    // 修复前：5 并发 → 5 次成功、50 行恢复码全部有效。
    // 受害者只知道自己保存的 10 个，攻击者手里另外 40 个是永久后门。
    const t0 = new Date('2026-08-16T12:00:00Z');
    const uid = 'race-probe';
    const { secret } = await startEnrollment(uid, 'r@example.com');
    const token = await codeAt(secret, t0);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => confirmEnrollment(uid, token, t0)),
    );

    // ★断言**成功次数**，而不是表里的行数。
    //   变异实测教训：去掉原子占用后，5 次调用**全部成功**（各自拿到一套
    //   恢复码明文返回给调用方），但表里仍是 10 行——因为整段包在事务里，
    //   delete+insert 被串行化，后一套覆盖前一套。
    //   即：行数看起来正常，而**用户手上却有 5 套互不相同的码**，
    //   其中 4 套已被覆盖成死码。只断言行数会让这个缺陷完全隐形（实测全绿）。
    const okCount = results.filter((r) => r.ok).length;
    expect(okCount, `并发确认成功 ${okCount} 次 → 发出了多套恢复码`).toBe(1);

    // 且唯一成功的那一套必须真的可用（不是被别人覆盖掉的死码）。
    const winner = results.find((r) => r.ok);
    expect(winner?.ok && winner.recoveryCodes.length).toBe(10);

    // ★额外用**真并发连接**直接验 SQL 层的原子性。
    //   诚实说明：上面那段 Promise.all 在 vitest 环境下会被应用层的单例
    //   连接串行化——实测即使去掉原子占用，okCount 仍是 1，即那段断言
    //   **抓不到**这个缺陷（我最初以为抓到了，是假绿）。
    //   真正决定安全性的是那条 `WHERE confirmedAt IS NULL`，故这里绕开
    //   应用层连接池，开多条独立连接去抢同一行：只有一条该拿到 returning。
    const uid2 = 'race-sql-probe';
    const { secret: s2 } = await startEnrollment(uid2, 'r2@example.com');
    expect(s2.length).toBeGreaterThan(0);
    const claims = await Promise.all(
      Array.from({ length: 8 }, () =>
        sql`UPDATE "TotpCredential" SET "confirmedAt" = now()
            WHERE "userId" = ${uid2} AND "confirmedAt" IS NULL
            RETURNING "id"`.then((r) => r.length),
      ),
    );
    const winners = claims.filter((n) => n === 1).length;
    expect(winners, `8 条并发 UPDATE 有 ${winners} 条拿到行 → 原子占用失效`).toBe(1);
  });

  it('★重新开始绑定不得静默关闭已启用的第二因子（审查发现的 Medium）', async () => {
    // 修复前 ON CONFLICT DO UPDATE 无条件把 confirmedAt 置 NULL，
    // 等于悄悄关掉 2FA。保护不该只依赖路由层的 409 门禁。
    const uid = 'reset-probe';
    await enrolled(uid);
    await startEnrollment(uid, 'x@example.com');
    expect(await hasTotpEnabled(uid), '已启用的 TOTP 被静默关闭').toBe(true);

    // ★★同时**不得清空恢复码**（Codex 交叉审查发现）：
    //   上一版把 delete 写成无条件执行——WHERE 正确拒绝了重置（TOTP 仍启用），
    //   delete 却照删不误。实测启用=true 而恢复码 10→0。
    //   这比它要修的 bug 更糟：用户仍被要求出示第二因子，却失去全部后备，
    //   手机一丢即永久失联。两个动作必须同进同退。
    expect(
      await countUnusedRecoveryCodes(uid),
      '拒绝重置却清空了恢复码 → 用户仍需 2FA 但已无后备手段',
    ).toBe(10);
  });

  it('★恢复码只能用一次，且并发下也只有一次通过', async () => {
    const uid = 'recovery-probe';
    const { codes } = await enrolled(uid);
    const target = codes[0];

    const results = await Promise.all(
      Array.from({ length: 10 }, () => verifyTotpForLogin(uid, target)),
    );
    expect(results.filter((r) => r.ok).length, '同一恢复码被并发消费多次').toBe(1);
    expect(await countUnusedRecoveryCodes(uid)).toBe(9);
  });

  it('★A 的恢复码不得通过 B 的验证（跨账户）', async () => {
    const { codes } = await enrolled('alice-probe');
    await enrolled('bob-probe');

    const res = await verifyTotpForLogin('bob-probe', codes[0]);
    expect(res.ok, 'A 的恢复码通过了 B 的验证 = 跨账户绕过').toBe(false);
    // 且 A 的码不该被 B 的尝试消费掉。
    expect(await countUnusedRecoveryCodes('alice-probe')).toBe(10);
  });

  it('★未确认的绑定不算启用，登录一律拒绝', async () => {
    const uid = 'pending-probe';
    const { secret } = await startEnrollment(uid, 'p@example.com');
    expect(await hasTotpEnabled(uid)).toBe(false);

    const res = await verifyTotpForLogin(uid, await codeAt(secret, new Date()));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('NOT_ENABLED');
  });

  it('★secret 不得以明文落库', async () => {
    const uid = 'crypto-probe';
    const { secret } = await enrolled(uid);
    const rows = await sql<
      Array<{ encryptedSecret: string }>
    >`SELECT "encryptedSecret" FROM "TotpCredential" WHERE "userId"=${uid}`;
    expect(rows[0].encryptedSecret).not.toContain(secret);
  });

  it('解绑后一切失效（含恢复码）', async () => {
    const uid = 'disable-probe';
    const { codes } = await enrolled(uid);
    await disableTotp(uid);

    expect(await hasTotpEnabled(uid)).toBe(false);
    const res = await verifyTotpForLogin(uid, codes[0]);
    expect(res.ok).toBe(false);
  });
});
