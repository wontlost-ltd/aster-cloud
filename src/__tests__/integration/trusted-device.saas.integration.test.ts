// 「记住该设备」的安全属性（issue #400）。
//
// ## 为什么必须用真 Postgres
//
// 守的都是**跨调用的状态性质**：token 只对签发它的用户有效、过期即失效、
// 可吊销。mock 掉 db 就是在测 mock。
//
// ## 这个功能本身削弱了什么（必须说清楚）
//
// 可信设备**只跳过第二因子，不跳过密码**——它把"两因子"降级为
// "一因子 + 一个长期持有物"。这是"记住设备"类功能的固有取舍，
// 故有 30 天上限 + 可吊销，而不是无限期。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { db } from '@/lib/prisma';
import { trustedDevices } from '@/db/schema';
import {
  TRUST_TTL_DAYS,
  coarseLabel,
  isTrustedDevice,
  issueTrustedDevice,
  listTrustedDevices,
  purgeExpiredTrustedDevices,
  revokeAllTrustedDevices,
  revokeTrustedDevice,
} from '@/lib/trusted-device';

const ALICE = 'u-alice-400';
const BOB = 'u-bob-400';
const NOW = new Date('2026-08-15T12:00:00.000Z');
const later = (days: number) => new Date(NOW.getTime() + days * 24 * 60 * 60_000);

import { cleanupTestDb, setupTestDb, teardownTestDb } from './setup-postgres';

describe.skipIf(process.env.LICENSE_E2E !== '1')('可信设备安全属性（issue #400）', () => {
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
    for (const u of [ALICE, BOB]) {
      await db.delete(trustedDevices).where(eq(trustedDevices.userId, u));
    }
  });

  it('★明文 token 不落库——只存 sha256', async () => {
    const token = await issueTrustedDevice(ALICE, 'Mozilla/5.0 Chrome/120', NOW);
    const [row] = await db
      .select()
      .from(trustedDevices)
      .where(eq(trustedDevices.userId, ALICE));

    expect(row.tokenHash).not.toBe(token);
    expect(row.tokenHash).toHaveLength(64);
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('★A 的 token 不得让 B 跳过验证（跨账户绕过）', async () => {
    // 只按 token 查而不校验 userId，就会让 A 的可信设备 cookie 在 B 登录时
    // 也生效——那是跨账户的二次验证绕过，本用例是本文件最重要的一条。
    const aliceToken = await issueTrustedDevice(ALICE, null, NOW);

    expect(await isTrustedDevice(ALICE, aliceToken, NOW)).toBe(true);
    expect(await isTrustedDevice(BOB, aliceToken, NOW)).toBe(false);
  });

  it('★过期 token 不放行', async () => {
    const token = await issueTrustedDevice(ALICE, null, NOW);
    expect(await isTrustedDevice(ALICE, token, later(TRUST_TTL_DAYS - 1))).toBe(true);
    expect(await isTrustedDevice(ALICE, token, later(TRUST_TTL_DAYS + 1))).toBe(false);
  });

  it('★吊销后立即失效（与不可吊销的 JWT session 不同）', async () => {
    const token = await issueTrustedDevice(ALICE, null, NOW);
    const [row] = await db
      .select({ id: trustedDevices.id })
      .from(trustedDevices)
      .where(eq(trustedDevices.userId, ALICE));

    expect(await revokeTrustedDevice(ALICE, row.id)).toBe(true);
    expect(await isTrustedDevice(ALICE, token, NOW)).toBe(false);
  });

  it('★不能吊销别人的设备', async () => {
    await issueTrustedDevice(ALICE, null, NOW);
    const [row] = await db
      .select({ id: trustedDevices.id })
      .from(trustedDevices)
      .where(eq(trustedDevices.userId, ALICE));

    expect(await revokeTrustedDevice(BOB, row.id)).toBe(false);
  });

  it('revokeAll 只清自己的——改密码时应调用', async () => {
    await issueTrustedDevice(ALICE, null, NOW);
    await issueTrustedDevice(ALICE, null, NOW);
    await issueTrustedDevice(BOB, null, NOW);

    expect(await revokeAllTrustedDevices(ALICE)).toBe(2);
    expect(await listTrustedDevices(BOB, NOW)).toHaveLength(1);
  });

  it('无 token / 空 token 一律不放行', async () => {
    await issueTrustedDevice(ALICE, null, NOW);
    expect(await isTrustedDevice(ALICE, null, NOW)).toBe(false);
    expect(await isTrustedDevice(ALICE, '', NOW)).toBe(false);
    expect(await isTrustedDevice(ALICE, 'deadbeef', NOW)).toBe(false);
  });

  it('列表不得泄露 tokenHash', async () => {
    await issueTrustedDevice(ALICE, 'Mozilla/5.0 Chrome/120', NOW);
    const list = await listTrustedDevices(ALICE, NOW);
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain('tokenHash');
  });

  it('★label 只存粗粒度描述，不存完整 UA', async () => {
    // 完整 UA 本身就接近指纹（版本号+引擎+机型足以缩小到很小的人群）。
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.109 Safari/537.36';
    expect(coarseLabel(ua)).toBe('Chrome on macOS');

    await issueTrustedDevice(ALICE, ua, NOW);
    const [row] = await db
      .select({ label: trustedDevices.label })
      .from(trustedDevices)
      .where(eq(trustedDevices.userId, ALICE));
    expect(row.label).toBe('Chrome on macOS');
    expect(row.label).not.toContain('537.36'); // 版本号未落库
  });

  it('★TTL 上界必须是字面量断言（M10：常量自证是重言式）', () => {
    // 审查实测：TRUST_TTL_DAYS 30→3650 时 13 条全绿——因为测试用
    // later(TRUST_TTL_DAYS ± 1) 做锚点，常量一动断言跟着动。
    // 安全参数的边界必须硬编码，不能引用被测常量。
    expect(TRUST_TTL_DAYS).toBeLessThanOrEqual(30);
  });

  it('★过期判定用硬编码天数（不引用被测常量）', async () => {
    const token = await issueTrustedDevice(ALICE, null, NOW);
    expect(await isTrustedDevice(ALICE, token, later(29))).toBe(true);
    expect(await isTrustedDevice(ALICE, token, later(31))).toBe(false);
  });

  it('★token 必须有足够熵（M12：只验 hash 长度抓不到熵变小）', async () => {
    // 审查实测：randomBytes(32)→randomBytes(2)（仅 65536 种）时 13 条全绿，
    // 因为只断言了 tokenHash 长 64——而 sha256 输出恒为 64，与输入熵无关。
    const t1 = await issueTrustedDevice(ALICE, null, NOW);
    expect(t1, '32 字节 hex = 64 字符').toHaveLength(64);

    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      seen.add(await issueTrustedDevice(ALICE, null, NOW));
    }
    expect(seen.size, 'token 重复=熵不足').toBe(20);
  });

  it('★lastUsedAt 必须在校验成功时刷新（M11：设备列表的唯一活跃信号）', async () => {
    const token = await issueTrustedDevice(ALICE, null, NOW);
    const before = await db
      .select({ v: trustedDevices.lastUsedAt })
      .from(trustedDevices)
      .where(eq(trustedDevices.userId, ALICE));
    expect(before[0].v).toBeNull();

    const used = later(1);
    expect(await isTrustedDevice(ALICE, token, used)).toBe(true);

    const after = await db
      .select({ v: trustedDevices.lastUsedAt })
      .from(trustedDevices)
      .where(eq(trustedDevices.userId, ALICE));
    expect(after[0].v, 'lastUsedAt 从未更新').not.toBeNull();
  });

  it('purge 只清过期的', async () => {
    await issueTrustedDevice(ALICE, null, NOW);
    expect(await purgeExpiredTrustedDevices(NOW)).toBe(0);
    expect(await purgeExpiredTrustedDevices(later(TRUST_TTL_DAYS + 1))).toBe(1);
  });
});

// ── 改密码必须吊销全部可信设备（issue #400）────────────────────────────
//
// ★这条不是"锦上添花"：走到改密/重置密码通常意味着密码已泄露或疑似泄露。
//   此时留着"跳过第二因子"的设备，等于给攻击者留了一条**只需旧密码**的通道
//   ——而旧密码正是可能已经落在他手里的那个。
//
// 用源码断言两条路径都接上了：真实调用需要起 Next route handler + session，
// 那是 e2e 范畴；这里守的是"接线还在"，不冒充验证 HTTP 行为。
describe('改密码吊销可信设备的接线（issue #400）', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

  it('★重置密码（忘记密码流程）必须吊销', () => {
    const src = read('src/app/api/auth/reset-password/route.ts');
    expect(src).toContain('revokeAllTrustedDevices');
    // 必须在密码真的写库之后——写库前吊销，若写库失败就白吊销了
    expect(src.indexOf('set({ passwordHash })')).toBeLessThan(
      src.indexOf('revokeAllTrustedDevices'),
    );
  });

  it('★已登录改密必须吊销', () => {
    const src = read('src/app/api/user/change-password/route.ts');
    expect(src).toContain('revokeAllTrustedDevices');
    expect(src.indexOf('passwordHash: newHash')).toBeLessThan(
      src.indexOf('revokeAllTrustedDevices'),
    );
  });

  it('★吊销失败不得阻断改密——密码已改，回滚更糟', () => {
    for (const p of [
      'src/app/api/auth/reset-password/route.ts',
      'src/app/api/user/change-password/route.ts',
    ]) {
      const src = read(p);
      const idx = src.indexOf('revokeAllTrustedDevices');
      // 该调用必须落在 try 块里
      expect(src.slice(Math.max(0, idx - 400), idx), p).toContain('try {');
    }
  });
});
