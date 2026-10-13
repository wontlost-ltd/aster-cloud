/**
 * 执行日志 / 决策骨架的留存清理（issue #396）。
 *
 * <p>把 `plans.ts` 里 `audit7days` / `audit90days` 这些**只写在定价页上的承诺**
 * 变成自执行的合约——参照 `telemetry-retention-gc` 的既有做法。
 *
 * <p>两类数据、两个 cutoff，一次扫完：
 * <ul>
 *   <li><b>执行日志行</b>：按租户 plan 取天数。无法判定的 plan（enterprise）
 *       **跳过不删**，并把原因带进返回值（见 resolveRetention 的说明）。</li>
 *   <li><b>决策骨架</b>：与 plan 解耦，统一 {@link SKELETON_RETENTION_DAYS}。
 *       骨架结构上不含 PII，可留更久；只清空该列，**不删整行**——
 *       行本身还要按 Audit 口径留存。</li>
 * </ul>
 */

import { and, inArray, isNotNull, lt, sql } from 'drizzle-orm';

import { db } from '@/lib/prisma';
import { executions, users } from '@/db/schema';
import { affectedRows, runInBatches } from '@/lib/retention/batching';

import {
  SKELETON_RETENTION_DAYS,
  retentionByPlan,
  type RetentionDecision,
} from './execution-retention';

export interface RetentionGcResult {
  /** 每个 plan 删了多少执行行 */
  readonly deletedByPlan: Readonly<Record<string, number>>;
  /**
   * **无法判定**留存期而被跳过的 plan 及原因——配置缺失，应当被人看见并修掉。
   *
   * ★不含"显式不限期"的档位：那些走 {@link unlimitedPlans}。
   * 混在一起会让真正缺配置的新档位被当成"又一个企业客户"忽略掉。
   */
  readonly skipped: ReadonlyArray<{ plan: string; reason: string }>;
  /** 显式声明不限期保留的 plan（enterprise）——正常状态，不是异常 */
  readonly unlimitedPlans: ReadonlyArray<string>;
  /** 清空了多少条骨架（只置 null，不删行） */
  readonly skeletonsCleared: number;
  readonly skeletonRetentionDays: number;
  /**
   * 本次是否清完了所有超期数据。false = 达到单次批数上限、还有积压，
   * 留给下一次 cron 继续（GC 幂等）。
   */
  readonly complete: boolean;
}

/**
 * 单批处理的行数上限：每批一条短语句。
 *
 * <p>历史积压可能有上百万行：一条语句删完是一个超长事务，且会撞上 Worker 的执行时限。
 */
export const GC_BATCH_SIZE = 5_000;

/**
 * 单次运行、每条清理轴的批数上限。积压一次清不完就留给下一次 cron，
 * 结果里 {@link RetentionGcResult.complete} 为 false。
 */
export const GC_MAX_BATCHES_PER_RUN = 100;

function cutoff(days: number, now: Date): Date {
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  return d;
}

/**
 * 跑一次留存清理。幂等：过了 cutoff 的行删掉后重跑即 no-op。
 *
 * @param now 注入当前时间以便测试；生产传 undefined 用系统时间
 */
export async function runExecutionRetentionGc(
  opts: { now?: Date; batchSize?: number; maxBatches?: number } = {},
): Promise<RetentionGcResult> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? GC_BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? GC_MAX_BATCHES_PER_RUN;
  let complete = true;
  const byPlan = retentionByPlan();

  const deletedByPlan: Record<string, number> = {};
  const skipped: Array<{ plan: string; reason: string }> = [];
  const unlimitedPlans: string[] = [];

  for (const [plan, decision] of Object.entries(byPlan) as Array<
    [string, RetentionDecision]
  >) {
    if (decision.unlimited) {
      // 显式不限期（enterprise）：按产品承诺执行，不是异常。
      unlimitedPlans.push(plan);
      continue;
    }
    if (decision.executionDays === null) {
      // ★无法判定 → 不删 + 留痕。静默跳过会让"配置缺失"看起来像 cron 没跑。
      skipped.push({ plan, reason: decision.skipReason ?? '未知原因' });
      continue;
    }

    // 该 plan 下的所有用户 id。用子查询而非 join delete：
    // drizzle 的 delete 不支持 join，且子查询在 userId 索引上足够快。
    const owners = db
      .select({ id: users.id })
      .from(users)
      .where(sql`${users.plan}::text = ${plan}`);

    const planCutoff = cutoff(decision.executionDays, now);
    const deleted = await runInBatches(
      async () => {
        const doomed = db
          .select({ id: executions.id })
          .from(executions)
          .where(and(lt(executions.createdAt, planCutoff), inArray(executions.userId, owners)))
          .limit(batchSize);
        return affectedRows(await db.delete(executions).where(inArray(executions.id, doomed)));
      },
      batchSize,
      maxBatches,
    );

    deletedByPlan[plan] = deleted.affected;
    complete &&= deleted.complete;
  }

  // 骨架：只清列不删行。已被上面按 plan 删掉的行自然不在了，剩下的行里
  // 若骨架超期就置 null——行本身仍按 Audit 口径保留。
  const skeletonCutoff = cutoff(SKELETON_RETENTION_DAYS, now);
  const cleared = await runInBatches(
    async () => {
      // 每批都重新挑：上一批已置 null 的行不再满足 isNotNull，不会被重复选中
      const stale = db
        .select({ id: executions.id })
        .from(executions)
        .where(and(lt(executions.createdAt, skeletonCutoff), isNotNull(executions.traceSkeletonJson)))
        .limit(batchSize);
      return affectedRows(
        await db.update(executions).set({ traceSkeletonJson: null }).where(inArray(executions.id, stale)),
      );
    },
    batchSize,
    maxBatches,
  );
  complete &&= cleared.complete;

  return {
    deletedByPlan,
    skipped,
    unlimitedPlans,
    skeletonsCleared: cleared.affected,
    skeletonRetentionDays: SKELETON_RETENTION_DAYS,
    complete,
  };
}
