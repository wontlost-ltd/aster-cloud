// 孤儿通知载荷的客户端安全助手：不得引入 server-only 或数据库依赖，铃铛组件会直接引用。

import { ORPHAN_KINDS } from '@/lib/guard-reconciliation/kinds';
import type { GuardOrphansDetectedNotification } from '@/lib/notifications';
import type { OrphanFeedSummary } from './feed-client';

const CRITICAL_KINDS: ReadonlySet<string> = new Set(
  ORPHAN_KINDS.filter((k) => k.severity === 'critical').map((k) => k.kind),
);

/** 通知跳转链接：带租户与 critical 过滤；租户 id 缺失时退回对账总览。 */
export function orphanNoticeHref(tenantId: string): string {
  if (!tenantId) return '/governance/reconciliation';
  return `/governance/reconciliation?tenant=${encodeURIComponent(tenantId)}&severity=critical`;
}

/** 通知行 id：同一租户、同一水位、同一收件人恒得同一 id，配合 ON CONFLICT DO NOTHING 保证幂等。 */
export function orphanNoticeId(tenantId: string, maxOrphanId: number, userId: string): string {
  return `guard-orphans:${tenantId}:${maxOrphanId}:${userId}`;
}

/** 载荷中 runIds 的上限。 */
const MAX_RUN_IDS = 8;

/**
 * 由通知源摘要构造铃铛载荷：逐字段显式拷贝白名单，绝不展开摘要对象，
 * 这样上报方可控的任何额外字段都进不了通知（ADR 0061 §3.6）。
 * critical kind 原样保留，其余（未知或非 critical）累加进 other。仅在 total > 0 时调用。
 */
export function buildOrphanNotice(summary: OrphanFeedSummary, tenantName: string): GuardOrphansDetectedNotification {
  const { firstDetectedAt, lastDetectedAt } = summary;
  if (!firstDetectedAt || !lastDetectedAt) {
    throw new Error(`orphan summary for ${summary.tenantId} lacks detection timestamps`);
  }
  const byKind: Record<string, number> = {};
  let other = 0;
  for (const [kind, count] of Object.entries(summary.byKind)) {
    if (CRITICAL_KINDS.has(kind)) byKind[kind] = count;
    else other += count;
  }
  if (other > 0) byKind.other = other;
  return {
    tenantId: summary.tenantId,
    tenantName,
    newTotal: summary.total,
    byKind,
    firstDetectedAt,
    lastDetectedAt,
    maxOrphanId: summary.maxId,
    runIds: summary.runIds.slice(0, MAX_RUN_IDS),
  };
}
