/**
 * Guard 对账治理页（ADR 0061 §3.7）的客户端辅助：不依赖 server-only，摘要卡与 /governance/reconciliation 共用。
 *
 * - 时间一律按 UTC 固定格式渲染并标注 `UTC`（SSR 与浏览器文本一致，避免水合不一致，同审批收件箱）；
 * - 页面 URL 与 BFF 查询串的序列化：与 aster-api 的查询串（orphanQueryToSearch）不同，BFF 缺省 severity
 *   即 `critical,warning`，故「不过滤」须显式写 `severity=all`。
 */
import type { UserProfile } from '@/lib/user-profiles';
import type { GuardOrphan, GuardOrphanQuery } from '@/services/policy/guard-types';
import { DEFAULT_ORPHAN_QUERY, SEVERITY_ALL } from './query';

/** 租户级路由返回的孤儿行：附带确认人资料（只解析本租户当前成员，离队成员为 null）。 */
export type OrphanItem = GuardOrphan & { acknowledgedByUser?: UserProfile | null };

/** 页面上的过滤条件（不含游标与每页条数）。 */
export type OrphanFilter = Pick<GuardOrphanQuery, 'status' | 'severities' | 'kind'>;

export const DEFAULT_ORPHAN_FILTER: Readonly<OrphanFilter> = Object.freeze({
  status: DEFAULT_ORPHAN_QUERY.status,
  severities: DEFAULT_ORPHAN_QUERY.severities,
});

const UTC_FORMAT = { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' } as const;

/** ISO 时间 → `<本地化日期时间> UTC`；无法解析时原样返回（不抛错）。 */
export function formatUtc(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${new Intl.DateTimeFormat(locale, UTC_FORMAT).format(date)} UTC`;
}

/** 过滤条件 → 查询串（键序固定：status、severity、kind）；BFF 与页面 URL 共用。 */
export function filterToSearch(filter: OrphanFilter): URLSearchParams {
  const out = new URLSearchParams({ status: filter.status });
  out.set('severity', filter.severities.length > 0 ? filter.severities.join(',') : SEVERITY_ALL);
  if (filter.kind) out.set('kind', filter.kind);
  return out;
}

/** 租户级列表请求地址；`before` 为「加载更多」的游标。 */
export function orphanListUrl(tenantId: string, filter: OrphanFilter, before?: number): string {
  const search = filterToSearch(filter);
  if (before !== undefined) search.set('before', String(before));
  return `/api/guard-reconciliation/${encodeURIComponent(tenantId)}?${search.toString()}`;
}

/** 明细页地址（不含 locale 前缀，交给 i18n Link / history）。 */
export function reconciliationPageHref(tenantId: string, filter?: OrphanFilter): string {
  const search = new URLSearchParams({ tenant: tenantId });
  if (filter) for (const [k, v] of filterToSearch(filter)) search.set(k, v);
  return `/governance/reconciliation?${search.toString()}`;
}

/** BFF 错误体（`{ error, message, requestId?, status? }`）；无法解析时各字段缺省。 */
export interface BffError {
  httpStatus: number;
  error?: string;
  requestId?: string;
  status?: string;
}

export async function readBffError(res: Response): Promise<BffError> {
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return {
    httpStatus: res.status,
    error: str(body?.error),
    requestId: str(body?.requestId) ?? res.headers.get('x-request-id') ?? undefined,
    status: str(body?.status),
  };
}
