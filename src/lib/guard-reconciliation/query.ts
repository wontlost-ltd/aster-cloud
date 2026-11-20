/**
 * 孤儿列表查询的解析与序列化（ADR 0061 §3.4 / §3.7）：BFF 路由与治理页共用，不依赖 server-only。
 *
 * 缺省 = OPEN + `critical,warning`、每页 50（ADR 0061 Q3：cloud from-evidence 的 ALLOW 在 ④ 上线前都会成为
 * info 类 `allow_unconsumed`，不过滤会淹没 critical）。`severity=all` 表示不按 severity 过滤（空数组）。
 * 任一参数非法或重复出现 → null（调用方回 400 `invalid_query`，不调用上游）。
 */
import type { GuardOrphanQuery } from '@/services/policy/guard-types';
import { isOrphanKind, isOrphanSeverity, ORPHAN_STATUSES } from './kinds';

export const ORPHAN_PAGE_DEFAULT = 50;
export const ORPHAN_PAGE_MAX = 200;
/** 不按 severity 过滤的显式取值。 */
export const SEVERITY_ALL = 'all';

/** 只读：parseOrphanQuery 返回新对象（含 severities 的拷贝），调用方修改结果不会影响缺省值。 */
export const DEFAULT_ORPHAN_QUERY: Readonly<GuardOrphanQuery> = Object.freeze<GuardOrphanQuery>({
  status: 'OPEN',
  severities: ['critical', 'warning'],
  limit: ORPHAN_PAGE_DEFAULT,
});

const POSITIVE_INT_RE = /^[1-9][0-9]{0,15}$/;

/** 单值参数：未给 → undefined；给了多次 → null（非法）。 */
function single(params: URLSearchParams, name: string): string | undefined | null {
  const all = params.getAll(name);
  if (all.length === 0) return undefined;
  return all.length === 1 ? all[0] : null;
}

function positiveInt(raw: string): number | null {
  if (!POSITIVE_INT_RE.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

function parseSeverities(raw: string | undefined): GuardOrphanQuery['severities'] | null {
  if (raw === undefined) return [...DEFAULT_ORPHAN_QUERY.severities];
  if (raw === SEVERITY_ALL) return [];
  const out: GuardOrphanQuery['severities'] = [];
  for (const v of raw.split(',')) {
    if (!isOrphanSeverity(v) || out.includes(v)) return null;
    out.push(v);
  }
  return out;
}

export function parseOrphanQuery(params: URLSearchParams): GuardOrphanQuery | null {
  const status = single(params, 'status');
  const severity = single(params, 'severity');
  const kind = single(params, 'kind');
  const limit = single(params, 'limit');
  const before = single(params, 'before');
  if ([status, severity, kind, limit, before].includes(null)) return null;

  const q: GuardOrphanQuery = { status: DEFAULT_ORPHAN_QUERY.status, severities: [], limit: DEFAULT_ORPHAN_QUERY.limit };
  if (status !== undefined) {
    if (!(ORPHAN_STATUSES as readonly string[]).includes(status as string)) return null;
    q.status = status as GuardOrphanQuery['status'];
  }
  const severities = parseSeverities(severity ?? undefined);
  if (!severities) return null;
  q.severities = severities;
  if (kind !== undefined) {
    if (!isOrphanKind(kind)) return null;
    q.kind = kind;
  }
  if (limit !== undefined) {
    const n = positiveInt(limit as string);
    if (n === null || n > ORPHAN_PAGE_MAX) return null;
    q.limit = n;
  }
  if (before !== undefined) {
    const n = positiveInt(before as string);
    if (n === null) return null;
    q.before = n;
  }
  return q;
}

/**
 * 发往 aster-api 的查询串（键序固定：status、severity、kind、limit、before）。severity 空数组时省略该键
 * （aster-api 缺省即不过滤）；多选以逗号连接（URLSearchParams 编码为 `%2C`，签名取同一原始串）。
 */
export function orphanQueryToSearch(q: GuardOrphanQuery): URLSearchParams {
  const out = new URLSearchParams({ status: q.status });
  if (q.severities.length > 0) out.set('severity', q.severities.join(','));
  if (q.kind) out.set('kind', q.kind);
  out.set('limit', String(q.limit));
  if (q.before !== undefined) out.set('before', String(q.before));
  return out;
}
