/**
 * 安全事件服务 - 审计日志
 *
 * 记录所有安全相关事件，用于审计、监控和合规。
 * 事件记录失败不会影响主业务流程。
 */

import { db, securityEvents } from '@/lib/prisma';
import { eq, and, gte, lte, inArray, lt, desc, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';

type SecurityEvent = InferSelectModel<typeof securityEvents>;
type SecurityEventType = SecurityEvent['eventType'];
type EventSeverity = SecurityEvent['severity'];

export interface SecurityEventData {
  eventType: SecurityEventType;
  severity: EventSeverity;
  policyId?: string;
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
  details: Record<string, unknown>;
}

export interface SecurityEventQueryOptions {
  startDate?: Date;
  endDate?: Date;
  eventTypes?: SecurityEventType[];
  severities?: EventSeverity[];
  policyId?: string;
  userId?: string;
  limit?: number;
  offset?: number;
}

/** 可写安全事件的客户端：全局 db 或调用方的事务。 */
type SecurityEventWriter = Pick<typeof db, 'insert' | 'transaction'>;

function insertSecurityEvent(writer: Pick<typeof db, 'insert'>, data: SecurityEventData) {
  return writer.insert(securityEvents).values({
    id: crypto.randomUUID(),
    eventType: data.eventType,
    severity: data.severity,
    policyId: data.policyId,
    userId: data.userId,
    ipAddress: data.ipAddress,
    userAgent: data.userAgent,
    requestId: data.requestId,
    details: data.details,
  });
}

/**
 * 记录安全事件
 *
 * 安全事件记录是异步的，失败不会影响主流程。
 * 生产环境建议配合消息队列实现可靠投递。
 *
 * 在调用方事务内记录时传入 tx：事件与业务写入同提交同回滚，且不向连接池要第二条连接
 * （Node 单例池满时事务会与自己互等）。写入包在保存点里，失败只回滚保存点，不污染外层事务。
 */
export async function logSecurityEvent(
  data: SecurityEventData,
  tx?: SecurityEventWriter,
): Promise<void> {
  try {
    if (tx) {
      await tx.transaction((savepoint) => insertSecurityEvent(savepoint, data));
    } else {
      await insertSecurityEvent(db, data);
    }
  } catch (error) {
    // 安全事件记录失败不应影响主流程
    console.error('[SecurityEvent] Failed to log event:', error);
  }
}

/**
 * 批量记录安全事件
 *
 * 用于高吞吐场景，减少数据库往返次数。
 */
export async function logSecurityEventsBatch(
  events: SecurityEventData[]
): Promise<{ success: number; failed: number }> {
  let success = 0;
  let failed = 0;

  try {
    await db.insert(securityEvents).values(
      events.map((e) => ({
        id: crypto.randomUUID(),
        eventType: e.eventType,
        severity: e.severity,
        policyId: e.policyId,
        userId: e.userId,
        ipAddress: e.ipAddress,
        userAgent: e.userAgent,
        requestId: e.requestId,
        details: e.details,
      }))
    );
    success = events.length;
  } catch (error) {
    console.error('[SecurityEvent] Batch insert failed:', error);
    failed = events.length;
  }

  return { success, failed };
}

/**
 * 查询安全事件（用于审计导出）
 */
export async function getSecurityEvents(
  options: SecurityEventQueryOptions
): Promise<{
  events: SecurityEvent[];
  total: number;
}> {
  const conditions = [];

  if (options.startDate) {
    conditions.push(gte(securityEvents.createdAt, options.startDate));
  }
  if (options.endDate) {
    conditions.push(lte(securityEvents.createdAt, options.endDate));
  }
  if (options.eventTypes?.length) {
    conditions.push(inArray(securityEvents.eventType, options.eventTypes));
  }
  if (options.severities?.length) {
    conditions.push(inArray(securityEvents.severity, options.severities));
  }
  if (options.policyId) {
    conditions.push(eq(securityEvents.policyId, options.policyId));
  }
  if (options.userId) {
    conditions.push(eq(securityEvents.userId, options.userId));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [events, totalResult] = await Promise.all([
    db.query.securityEvents.findMany({
      where: whereClause,
      orderBy: [desc(securityEvents.createdAt)],
      limit: options.limit ?? 100,
      offset: options.offset ?? 0,
    }),
    db.select({ count: sql<number>`count(*)::int` })
      .from(securityEvents)
      .where(whereClause ?? sql`true`),
  ]);

  return { events, total: totalResult[0]?.count || 0 };
}

/**
 * 获取安全事件统计（用于监控仪表盘）
 *
 * ★租户隔离：`userId` 为**必填**。此前本函数签名里没有 userId，路由校验了登录态却
 * 从不传租户维度，任意登录用户都能拿到全平台按 severity/type 的安全事件统计
 * （与兄弟函数 getSecurityEvents 曾犯的是同一个错，那边已修、这边漏修）。
 *
 * 这里刻意做成**必填而非可选**：可选参数正是上一次漏修的成因——调用方少传一个字段
 * 就静默退化成跨租户全表聚合，且类型检查不报错。必填后漏传即编译失败。
 */
export async function getSecurityEventStats(options: {
  userId: string;
  startDate: Date;
  endDate: Date;
  policyId?: string;
}): Promise<{
  total: number;
  bySeverity: Record<EventSeverity, number>;
  byType: Record<string, number>;
  errorRate: number;
}> {
  if (!options.userId) {
    throw new Error('userId 必需：安全事件统计不支持跨租户聚合（防越权读）');
  }

  const conditions = [
    gte(securityEvents.createdAt, options.startDate),
    lte(securityEvents.createdAt, options.endDate),
    eq(securityEvents.userId, options.userId),
  ];

  if (options.policyId) {
    conditions.push(eq(securityEvents.policyId, options.policyId));
  }

  const whereClause = and(...conditions);

  const [totalResult, bySeverityData, byTypeData] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` })
      .from(securityEvents)
      .where(whereClause),
    db.select({
      severity: securityEvents.severity,
      count: sql<number>`count(*)::int`,
    })
      .from(securityEvents)
      .where(whereClause)
      .groupBy(securityEvents.severity),
    db.select({
      eventType: securityEvents.eventType,
      count: sql<number>`count(*)::int`,
    })
      .from(securityEvents)
      .where(whereClause)
      .groupBy(securityEvents.eventType),
  ]);

  const total = totalResult[0]?.count || 0;

  const bySeverity = {
    INFO: 0,
    WARNING: 0,
    ERROR: 0,
    CRITICAL: 0,
  } as Record<EventSeverity, number>;

  for (const item of bySeverityData) {
    bySeverity[item.severity] = item.count;
  }

  const byType: Record<string, number> = {};
  for (const item of byTypeData) {
    byType[item.eventType] = item.count;
  }

  const errorCount = bySeverity.ERROR + bySeverity.CRITICAL;
  const errorRate = total > 0 ? errorCount / total : 0;

  return {
    total,
    bySeverity,
    byType,
    errorRate,
  };
}

/**
 * 清理旧的安全事件（用于数据保留策略）
 *
 * 注意：删除前应确保已导出到长期存储。
 */
export async function cleanupOldSecurityEvents(
  olderThan: Date
): Promise<number> {
  const result = await db.delete(securityEvents)
    .where(lt(securityEvents.createdAt, olderThan))
    .returning();

  return result.length;
}
