/**
 * Guard 对账孤儿类别表（ADR 0054 §10.3，ADR 0061 §3.4）：服务端与客户端共用，不依赖 server-only。
 *
 * 与 aster-api `OrphanKind` 逐项对应（顺序、字面量、severity、是否自动解除），由 `kinds.test.ts` 钉住；
 * aster-api 新增 kind 时这里与测试须同步改（有意让测试失败）。severity 计数由本表从摘要的 `open`（按 kind）算出，
 * aster-api 不另给 severity 维度的计数。
 */
import type { GuardOrphanKind, GuardOrphanSeverity, GuardReconciliationSummary } from '@/services/policy/guard-types';

export interface OrphanKindInfo {
  kind: GuardOrphanKind;
  severity: GuardOrphanSeverity;
  /** 对账是否会自动解除（补到结果 → late_result；检出满 TTL → aged_out）；其余只能由管理员确认。 */
  autoResolvable: boolean;
}

export const ORPHAN_KINDS: readonly OrphanKindInfo[] = Object.freeze([
  { kind: 'side_effect_without_decision', severity: 'critical', autoResolvable: false },
  { kind: 'side_effect_unconsumed', severity: 'critical', autoResolvable: false },
  { kind: 'side_effect_mismatch', severity: 'critical', autoResolvable: false },
  { kind: 'consumed_without_result', severity: 'warning', autoResolvable: true },
  { kind: 'allow_unconsumed', severity: 'info', autoResolvable: true },
  { kind: 'consume_on_non_allow', severity: 'critical', autoResolvable: false },
  { kind: 'result_without_consume', severity: 'critical', autoResolvable: false },
  { kind: 'orphan_receipt', severity: 'info', autoResolvable: true },
] as const);

/** 严重度从高到低。 */
export const ORPHAN_SEVERITIES: readonly GuardOrphanSeverity[] = Object.freeze(['critical', 'warning', 'info'] as const);

export const ORPHAN_STATUSES = Object.freeze(['OPEN', 'RESOLVED', 'ACKNOWLEDGED'] as const);

const BY_KIND: ReadonlyMap<string, OrphanKindInfo> = new Map(ORPHAN_KINDS.map((k) => [k.kind, k]));

export function isOrphanKind(value: unknown): value is GuardOrphanKind {
  return typeof value === 'string' && BY_KIND.has(value);
}

export function isOrphanSeverity(value: unknown): value is GuardOrphanSeverity {
  return typeof value === 'string' && (ORPHAN_SEVERITIES as readonly string[]).includes(value);
}

export function severityOf(kind: GuardOrphanKind): GuardOrphanSeverity {
  const info = BY_KIND.get(kind);
  if (!info) throw new Error(`unknown orphan kind: ${kind}`);
  return info.severity;
}

export function isAutoResolvable(kind: GuardOrphanKind): boolean {
  return BY_KIND.get(kind)?.autoResolvable ?? false;
}

/** 按 severity 汇总摘要的 OPEN 计数；未知 kind（更新的 aster-api）忽略，非有限数按 0 计。 */
export function countsBySeverity(open: GuardReconciliationSummary['open']): Record<GuardOrphanSeverity, number> {
  const out: Record<GuardOrphanSeverity, number> = { critical: 0, warning: 0, info: 0 };
  for (const [kind, n] of Object.entries(open ?? {})) {
    const info = BY_KIND.get(kind);
    if (info && typeof n === 'number' && Number.isFinite(n)) out[info.severity] += n;
  }
  return out;
}
