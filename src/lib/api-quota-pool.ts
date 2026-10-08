/**
 * owner 共享配额池（ADR 0015 §4）：owner 个人 key 的调用 + owner 名下团队 key 的调用共用一个月度池。
 * 旧行 quotaOwnerId 为 NULL，按持有者归池（COALESCE 语义），不做回填。
 *
 * 所有"按月统计 API 调用量"的入口（precheck、usage GET、dashboard 用量卡片）都必须经由本模块，
 * 保证限流判定与展示口径一致。
 */
import { db, apiCallRecords } from '@/lib/prisma';
import { and, eq, isNull, or, sql, type SQL } from 'drizzle-orm';

/** 计费月份 'YYYY-MM'，按 UTC 切月，与 apiCallRecords.periodMonth 写入口径一致。 */
export function currentPeriodMonth(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * 属于 owner 池的调用：quotaOwnerId = owner，或旧行（quotaOwnerId 为 NULL）且持有者就是 owner。
 * 拆成 OR 而非 COALESCE(...) = owner，以便分别命中 quotaOwnerId 与 userId 两条索引。
 */
export function ownerPoolCondition(ownerId: string): SQL {
  return or(
    eq(apiCallRecords.quotaOwnerId, ownerId),
    and(isNull(apiCallRecords.quotaOwnerId), eq(apiCallRecords.userId, ownerId))
  )!;
}

/** owner 池在指定月份内的成功调用数（仅 status = 'success' 计入配额）。 */
export async function countOwnerPoolUsage(ownerId: string, periodMonth: string): Promise<number> {
  const r = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(apiCallRecords)
    .where(and(ownerPoolCondition(ownerId), eq(apiCallRecords.periodMonth, periodMonth), eq(apiCallRecords.status, 'success')));
  return r[0]?.c ?? 0;
}
