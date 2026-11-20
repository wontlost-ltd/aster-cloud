/**
 * 跨租户对账摘要（ADR 0061 §3.7，治理页摘要卡）。
 *
 * 租户 = listReconciliationTenants（个人租户 + 角色 ≥ member 的团队）；逐租户经 createReconciliationClient
 * （现查角色、签真实角色）取 aster-api 摘要，并发上限 4（同审批收件箱）、单租户超时 GUARD_TIMEOUT_MS（客户端内），
 * 单租户失败只记入 unavailableTenants。severity 计数由本地 kind 表从 `open` 算出（ADR 0061 R2）。
 */
import 'server-only';

import { createLimiter } from '@/services/evidence/receipts-client';
import type { GuardOrphanSeverity } from '@/services/policy/guard-types';
import { createReconciliationClient, listReconciliationTenants, type ReconciliationTenant } from './access';
import { countsBySeverity } from './kinds';

export const OVERVIEW_CONCURRENCY = 4;

export interface ReconciliationTenantSummary {
  tenantId: string;
  /** 空串 = 个人租户。 */
  tenantName: string;
  canAck: boolean;
  lastRunAt: string | null;
  openBySeverity: Record<GuardOrphanSeverity, number>;
  openTotal: number;
}

export interface ReconciliationOverview {
  tenants: ReconciliationTenantSummary[];
  unavailableTenants: string[];
}

/** 两次读角色之间被移出 / 降级：该租户不再可见，既不进结果也不算不可用。 */
const GONE = Symbol('gone');

async function tenantSummary(tenant: ReconciliationTenant, userId: string): Promise<ReconciliationTenantSummary | typeof GONE> {
  const rec = await createReconciliationClient(tenant.id, userId);
  if (!rec) return GONE;
  const summary = await rec.api.summary();
  return {
    tenantId: tenant.id,
    tenantName: tenant.name,
    canAck: rec.access.canAck,
    lastRunAt: summary.lastRun?.finishedAt ?? null,
    openBySeverity: countsBySeverity(summary.open),
    openTotal: summary.openTotal,
  };
}

/** critical 降序 → openTotal 降序 → 个人租户优先 → 名称。 */
function compare(userId: string) {
  return (a: ReconciliationTenantSummary, b: ReconciliationTenantSummary): number =>
    b.openBySeverity.critical - a.openBySeverity.critical ||
    b.openTotal - a.openTotal ||
    Number(b.tenantId === userId) - Number(a.tenantId === userId) ||
    a.tenantName.localeCompare(b.tenantName);
}

export async function listReconciliationOverview(userId: string): Promise<ReconciliationOverview> {
  const tenants = await listReconciliationTenants(userId);
  const limit = createLimiter(OVERVIEW_CONCURRENCY);
  const settled = await Promise.allSettled(tenants.map((t) => limit(() => tenantSummary(t, userId))));

  const out: ReconciliationTenantSummary[] = [];
  const unavailableTenants: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error('[guard-reconciliation] tenant unavailable', { tenantId: tenants[i].id, err: r.reason });
      unavailableTenants.push(tenants[i].id);
    } else if (r.value !== GONE) {
      out.push(r.value);
    }
  });
  return { tenants: out.sort(compare(userId)), unavailableTenants };
}
