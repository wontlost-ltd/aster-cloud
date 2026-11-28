import 'server-only';

import { inArray, sql } from 'drizzle-orm';

import { freshDb } from '@/db/fresh-read';
import { db, guardOrphanNotifyState, notifications } from '@/lib/prisma';
import type { GuardOrphansDetectedNotification } from '@/lib/notifications';

export interface NotifyState {
  tenantId: string;
  notifiedThroughId: number;
  lastNoticeAt: Date | null;
  pendingSince: Date | null;
}

export interface TenantNotice {
  id: string;
  userId: string;
  data: GuardOrphansDetectedNotification;
}

export interface CommitTenantNoticeParams {
  tenantId: string;
  /** 本 tick 读到并用于调用 ② 的水位；比较后写的期望旧值（R3）。 */
  expectedThroughId: number;
  newThroughId: number;
  notices: TenantNotice[];
  now: Date;
}

const LOAD_BATCH_SIZE = 200;
/** 批量写入的 VALUES 分块大小，与读取批大小一致。 */
const WRITE_BATCH_SIZE = LOAD_BATCH_SIZE;

/** 事务内比较失败时抛出，用于强制回滚；只在本模块内部被捕获。 */
class CasLostError extends Error {
  constructor() {
    super('guard orphan notify watermark compare-and-set lost');
  }
}

/**
 * 原生 SQL 绑定时间值一律转成 ISO 字符串：列是 timestamp without time zone，
 * 直接绑 Date 会按进程本地时区序列化，在非 UTC 机器上整体偏移。
 */
const ts = (d: Date) => d.toISOString();

/** 读取水位；缺行的租户不在结果中（调用方视为 notifiedThroughId = 0）。经 freshDb 读，避免 Hyperdrive 缓存旧水位。 */
export async function loadNotifyStates(tenantIds: string[]): Promise<Map<string, NotifyState>> {
  const result = new Map<string, NotifyState>();
  for (let i = 0; i < tenantIds.length; i += LOAD_BATCH_SIZE) {
    const batch = tenantIds.slice(i, i + LOAD_BATCH_SIZE);
    const rows = await freshDb
      .select({
        tenantId: guardOrphanNotifyState.tenantId,
        notifiedThroughId: guardOrphanNotifyState.notifiedThroughId,
        lastNoticeAt: guardOrphanNotifyState.lastNoticeAt,
        pendingSince: guardOrphanNotifyState.pendingSince,
      })
      .from(guardOrphanNotifyState)
      .where(inArray(guardOrphanNotifyState.tenantId, batch));
    for (const row of rows) result.set(row.tenantId, row);
  }
  return result;
}

/**
 * 记录「水位之上有新增但被推迟」的首次观察时刻：缺行则建行（水位 0），已有 pendingSince 保持最早值。
 * 原生 upsert 不触发 drizzle 的 $onUpdate，故 updatedAt 显式写入。
 */
export async function markPending(tenantIds: string[], now: Date): Promise<void> {
  // 同一条 INSERT 里重复的冲突键会触发「cannot affect row a second time」，先去重。
  const unique = [...new Set(tenantIds)];
  const at = ts(now);
  for (let i = 0; i < unique.length; i += WRITE_BATCH_SIZE) {
    const values = sql.join(
      unique.slice(i, i + WRITE_BATCH_SIZE).map((t) => sql`(${t}, 0, ${at}::timestamp, ${at}::timestamp)`),
      sql`, `,
    );
    await db.execute(sql`
      INSERT INTO "GuardOrphanNotifyState" ("tenantId", "notifiedThroughId", "pendingSince", "updatedAt")
      VALUES ${values}
      ON CONFLICT ("tenantId") DO UPDATE SET
        "pendingSince" = COALESCE("GuardOrphanNotifyState"."pendingSince", EXCLUDED."pendingSince"),
        "updatedAt" = EXCLUDED."updatedAt"
    `);
  }
}

/** 清除推迟标记；行不存在时无操作。原生 UPDATE 不触发 $onUpdate，updatedAt 显式写入。 */
export async function clearPending(tenantId: string): Promise<void> {
  await db.execute(sql`
    UPDATE "GuardOrphanNotifyState" SET "pendingSince" = NULL, "updatedAt" = ${ts(new Date())}::timestamp
    WHERE "tenantId" = ${tenantId} AND "pendingSince" IS NOT NULL
  `);
}

/**
 * 清除不再是候选的租户的 pendingSince：keepTenantIds 之外所有带推迟标记的行一次清掉
 * （租户已无水位之上的 OPEN critical 孤儿，不应再计入待通知时长或插队）。空名单清除全部。
 * 水位与 lastNoticeAt 不动；原生 UPDATE 不触发 $onUpdate，updatedAt 显式写入。
 */
export async function clearStalePending(keepTenantIds: string[], now: Date): Promise<void> {
  const keepArray =
    keepTenantIds.length > 0
      ? sql`ARRAY[${sql.join(keepTenantIds.map((t) => sql`${t}`), sql`, `)}]::text[]`
      : sql`ARRAY[]::text[]`;
  await db.execute(sql`
    UPDATE "GuardOrphanNotifyState" SET "pendingSince" = NULL, "updatedAt" = ${ts(now)}::timestamp
    WHERE "pendingSince" IS NOT NULL AND NOT ("tenantId" = ANY(${keepArray}))
  `);
}

/**
 * 水位推进与通知行插入同处一个事务，水位以期望旧值做比较后写（R3）：
 * 比较失败（另一个 tick 已推进）则整事务回滚并返回 'cas_lost'，通知行不会重复。
 * 通知行 id 幂等（ON CONFLICT DO NOTHING）；收件人为空时只推进水位，不写 lastNoticeAt（R7）。
 */
export async function commitTenantNotice(p: CommitTenantNoticeParams): Promise<'committed' | 'cas_lost'> {
  if (p.newThroughId <= p.expectedThroughId) {
    throw new Error(
      `newThroughId (${p.newThroughId}) must be greater than expectedThroughId (${p.expectedThroughId})`,
    );
  }
  const nowIso = ts(p.now);
  const noticeAt = p.notices.length > 0 ? nowIso : null;
  try {
    await db.transaction(async (tx) => {
      const advanced = await tx.execute(sql`
        INSERT INTO "GuardOrphanNotifyState"
          ("tenantId", "notifiedThroughId", "lastNoticeAt", "pendingSince", "updatedAt")
        VALUES (${p.tenantId}, ${p.newThroughId}, ${noticeAt}::timestamp, NULL, ${nowIso}::timestamp)
        ON CONFLICT ("tenantId") DO UPDATE SET
          "notifiedThroughId" = EXCLUDED."notifiedThroughId",
          "lastNoticeAt" = COALESCE(EXCLUDED."lastNoticeAt", "GuardOrphanNotifyState"."lastNoticeAt"),
          "pendingSince" = NULL,
          "updatedAt" = EXCLUDED."updatedAt"
        WHERE "GuardOrphanNotifyState"."notifiedThroughId" = ${p.expectedThroughId}
        RETURNING "tenantId"
      `);
      // postgres-js 返回类数组结果，node-postgres 返回带 rows 的对象，两者都要兼容。
      const rows = Array.isArray(advanced) ? advanced : ((advanced as { rows?: unknown[] }).rows ?? []);
      if (rows.length === 0) throw new CasLostError();

      if (p.notices.length > 0) {
        await tx
          .insert(notifications)
          .values(
            p.notices.map((n) => ({
              id: n.id,
              userId: n.userId,
              kind: 'guard.orphans_detected',
              data: n.data,
              readAt: null,
              createdAt: p.now,
            })),
          )
          .onConflictDoNothing({ target: notifications.id });
      }
    });
  } catch (err) {
    if (err instanceof CasLostError) return 'cas_lost';
    throw err;
  }
  return 'committed';
}
