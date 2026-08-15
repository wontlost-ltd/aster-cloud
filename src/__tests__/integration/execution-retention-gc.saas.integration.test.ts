// 执行日志留存 GC 的**真实删除行为**（issue #396）。
//
// ## 为什么必须用真 Postgres
//
// 单测（execution-retention.test.ts / whatif-window-retention.test.ts）只守
// **解析规则**——featureKey → 天数、无法判定时不猜、窗口裁剪。它们证明不了
// 「删对了行」：删除走的是 drizzle 的 delete + 子查询 + 时间比较，
// mock 掉 db 就等于在测 mock。
//
// 本文件补的正是那一层：造三档租户的跨 cutoff 数据，跑一次 GC，
// 断言**每档各自剩下什么**。
//
// ★这条 cron 会真删生产数据。在本文件绿之前，不应把它放开到生产——
// 那时只有「算出来的天数是对的」这一半证据。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

import { db, executions, policies, users } from '@/lib/prisma';
import { runExecutionRetentionGc } from '@/lib/retention/execution-retention-gc';
import { SKELETON_RETENTION_DAYS } from '@/lib/retention/execution-retention';

import { cleanupTestDb, setupTestDb, teardownTestDb } from './setup-postgres';

const DAY = 24 * 60 * 60 * 1000;
/** 固定"现在"，让 cutoff 可精确断言，不受跑测时刻影响。 */
const NOW = new Date('2026-08-15T12:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

const U_FREE = 'u-free-396';
const U_PRO = 'u-pro-396';
const U_ENT = 'u-ent-396';
const ALL_USERS = [U_FREE, U_PRO, U_ENT];

const POL = (u: string) => `pol-${u}`;

/** 造一条执行；id 带上语义便于断言失败时定位。 */
async function seedExecution(
  userId: string,
  ageDays: number,
  opts: { withSkeleton?: boolean } = {},
): Promise<string> {
  const id = `exec-${userId}-${ageDays}d`;
  await db.insert(executions).values({
    id,
    userId,
    policyId: POL(userId),
    createdAt: ago(ageDays),
    // ★input / durationMs 都是 NOT NULL 且无默认值——真实 schema 约束。
    //   这类事 mock 掉 db 就发现不了：单测里 insert 一个残缺对象照样"通过"。
    input: { probe: ageDays },
    durationMs: 1,
    success: true,
    decision: 'approved',
    source: 'api',
    ...(opts.withSkeleton
      ? {
          traceSkeletonJson: {
            schemaVersion: 'trace-skeleton/v1',
            steps: [{ stepId: '0.1', expression: 'if condition @L1', matched: true, depth: 0 }],
          },
        }
      : {}),
  } as typeof executions.$inferInsert);
  return id;
}

async function seedTenant(userId: string, plan: string) {
  await db.insert(users).values({ id: userId, plan } as typeof users.$inferInsert);
  await db.insert(policies).values({
    id: POL(userId),
    userId,
    name: `policy for ${plan}`,
    content: 'Module aster.test. Rule r: Return 1.',
  } as typeof policies.$inferInsert);
}

async function survivingIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: executions.id })
    .from(executions)
    .where(eq(executions.userId, userId));
  return rows.map((r) => r.id).sort();
}

describe.skipIf(process.env.LICENSE_E2E !== '1')(
  '执行日志留存 GC 真实删除行为（issue #396）',
  () => {
    beforeAll(async () => {
      (process.env as Record<string, string>).NODE_ENV = 'test';
      process.env.DEPLOYMENT_MODE = 'saas';
      await setupTestDb();
    }, 120_000);

    afterAll(async () => {
      await teardownTestDb();
    });

    beforeEach(async () => {
      await cleanupTestDb();
      // ★User 不在 setup-postgres 的 TRUNCATE 列表里，必须自己清，
      //   否则第二个 it 插同 id 会撞主键。
      await db.delete(users).where(inArray(users.id, ALL_USERS));

      await seedTenant(U_FREE, 'free');
      await seedTenant(U_PRO, 'pro');
      await seedTenant(U_ENT, 'enterprise');
    });

    it('★free 只留 7 天内、pro 只留 90 天内、enterprise 一条不删', async () => {
      // 每档都造「刚好在界内」「刚好在界外」「远超界外」三条。
      await seedExecution(U_FREE, 1);
      await seedExecution(U_FREE, 6);
      await seedExecution(U_FREE, 30);
      await seedExecution(U_FREE, 400);

      await seedExecution(U_PRO, 1);
      await seedExecution(U_PRO, 89);
      await seedExecution(U_PRO, 120);
      await seedExecution(U_PRO, 400);

      await seedExecution(U_ENT, 1);
      await seedExecution(U_ENT, 400);
      await seedExecution(U_ENT, 3000);

      const result = await runExecutionRetentionGc({ now: NOW });

      expect(await survivingIds(U_FREE)).toEqual(
        [`exec-${U_FREE}-1d`, `exec-${U_FREE}-6d`].sort(),
      );
      expect(await survivingIds(U_PRO)).toEqual(
        [`exec-${U_PRO}-1d`, `exec-${U_PRO}-89d`].sort(),
      );

      // ★enterprise 无 audit featureKey → 不删，且原因必须出现在返回值里。
      //   静默跳过会让「企业数据没被清」看起来像 cron 没跑。
      expect(await survivingIds(U_ENT)).toHaveLength(3);
      // ★enterprise 现在是**显式不限期**（auditUnlimited），不是「无法判定」。
      //   两者都不删，但必须分开表达：混在 skipped 里，真正缺配置的新档位
      //   会被当成「又一个企业客户」淹没掉。
      expect(result.unlimitedPlans).toContain('enterprise');
      expect(result.skipped.map((s) => s.plan)).not.toContain('enterprise');

      expect(result.deletedByPlan.free).toBe(2);
      expect(result.deletedByPlan.pro).toBe(2);
      expect(result.deletedByPlan).not.toHaveProperty('enterprise');
    });

    it('★幂等：同一时刻重跑第二次删 0 条', async () => {
      await seedExecution(U_FREE, 30);
      await seedExecution(U_PRO, 120);

      const first = await runExecutionRetentionGc({ now: NOW });
      expect(first.deletedByPlan.free).toBe(1);
      expect(first.deletedByPlan.pro).toBe(1);

      const second = await runExecutionRetentionGc({ now: NOW });
      expect(second.deletedByPlan.free).toBe(0);
      expect(second.deletedByPlan.pro).toBe(0);
    });

    it('★骨架按独立 cutoff 清空，且只清列不删行', async () => {
      // 骨架 365 天、pro 执行日志 90 天——两条独立的轴。
      // 用 enterprise（执行日志不删）来隔离出「只清骨架」这一个变量，
      // 否则行会先被按 plan 删掉，看不出是清列还是删行。
      const young = await seedExecution(U_ENT, 10, { withSkeleton: true });
      const old = await seedExecution(U_ENT, SKELETON_RETENTION_DAYS + 30, {
        withSkeleton: true,
      });

      const result = await runExecutionRetentionGc({ now: NOW });

      expect(result.skeletonsCleared).toBe(1);
      expect(result.skeletonRetentionDays).toBe(SKELETON_RETENTION_DAYS);

      // ★行还在——只是骨架列被置 null
      const rows = await db
        .select({ id: executions.id, skeleton: executions.traceSkeletonJson })
        .from(executions)
        .where(inArray(executions.id, [young, old]));

      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.id === young)?.skeleton).toBeTruthy();
      expect(rows.find((r) => r.id === old)?.skeleton).toBeNull();
    });

    it('骨架留存长于 pro 的执行日志留存——两轴不得混为一条', async () => {
      // pro 的 120 天执行会被整行删掉（>90），连带骨架消失；
      // 而 enterprise 的同龄执行行还在、骨架也还在（<365）。
      // 这正是「漏斗还有数据但 What-If 空窗」的真实形态。
      await seedExecution(U_PRO, 120, { withSkeleton: true });
      const entRow = await seedExecution(U_ENT, 120, { withSkeleton: true });

      await runExecutionRetentionGc({ now: NOW });

      expect(await survivingIds(U_PRO)).toHaveLength(0);

      const [ent] = await db
        .select({ skeleton: executions.traceSkeletonJson })
        .from(executions)
        .where(eq(executions.id, entRow));
      expect(ent.skeleton).toBeTruthy();
    });
  },
);
