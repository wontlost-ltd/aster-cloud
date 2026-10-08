/**
 * 审批收件箱聚合（ADR 0042 §5.2）。
 *
 * 租户集合 = 个人租户（tenantId = userId）∪ 用户所在全部团队；逐租户以该用户身份（含该租户的已验证业务角色）
 * 拉 guard 审批列表，并发上限 4，单租户失败只记入 unavailableTenants，不影响其他租户。
 * canAct 只是 UI 提示：真正的角色匹配与四眼判定在 aster-api，cloud 不重复判定。
 */
import 'server-only';

import { eq } from 'drizzle-orm';
import { loadBusinessRoles } from '@/lib/business-roles';
import { db, teamMembers } from '@/lib/prisma';
import { createPolicyApiClientForUser } from '@/lib/policy-api-identity';
import { createLimiter } from '@/services/evidence/receipts-client';
import type { GuardApprovalItem, GuardApprovalStatus } from '@/services/policy/guard-types';

export const GUARD_APPROVAL_STATUSES: readonly GuardApprovalStatus[] = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'];

/** 与证据导出共用的 aster-api 在途上限。 */
const INBOX_CONCURRENCY = 4;
/** api 单页上限（服务端夹取到 1–200）；收件箱只取首页，超出部分属于运维问题而非 UI 分页问题。 */
const INBOX_PAGE_SIZE = 200;

export type InboxItem = GuardApprovalItem & { tenantId: string; tenantName: string; canAct: boolean };

export interface InboxResult {
  items: InboxItem[];
  unavailableTenants: string[];
}

interface Tenant {
  id: string;
  /** 个人租户无团队名，留空由 UI 显示本地化的「个人」。 */
  name: string;
}

export function isGuardApprovalStatus(value: unknown): value is GuardApprovalStatus {
  return typeof value === 'string' && (GUARD_APPROVAL_STATUSES as readonly string[]).includes(value);
}

/** 可审 = 仍待审且（ESCALATE 任意成员，或所需角色 ∈ 该租户已验证角色，大小写敏感精确匹配）。 */
export function canActOn(item: GuardApprovalItem, roles: readonly string[]): boolean {
  if (item.status !== 'PENDING') return false;
  return item.requiredRole == null || roles.includes(item.requiredRole);
}

async function listUserTenants(userId: string): Promise<Tenant[]> {
  const memberships = await db.query.teamMembers.findMany({
    where: eq(teamMembers.userId, userId),
    columns: { teamId: true },
    with: { team: { columns: { name: true } } },
  });
  return [{ id: userId, name: '' }, ...memberships.map((m) => ({ id: m.teamId, name: m.team?.name ?? m.teamId }))];
}

async function listTenantApprovals(tenant: Tenant, userId: string, status: GuardApprovalStatus): Promise<InboxItem[]> {
  const [client, roles] = await Promise.all([
    createPolicyApiClientForUser(tenant.id, userId),
    loadBusinessRoles(userId, tenant.id),
  ]);
  const page = await client.listGuardApprovals(status, 0, INBOX_PAGE_SIZE);
  return page.items.map((item) => ({
    ...item,
    tenantId: tenant.id,
    tenantName: tenant.name,
    canAct: canActOn(item, roles),
  }));
}

/** createdAt 倒序；缺时间的项排最后。 */
function byCreatedAtDesc(a: InboxItem, b: InboxItem): number {
  return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
}

export async function listUserApprovals(userId: string, status: GuardApprovalStatus): Promise<InboxResult> {
  const tenants = await listUserTenants(userId);
  const limit = createLimiter(INBOX_CONCURRENCY);
  const settled = await Promise.allSettled(tenants.map((t) => limit(() => listTenantApprovals(t, userId, status))));

  const items: InboxItem[] = [];
  const unavailableTenants: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      items.push(...r.value);
      return;
    }
    console.error('[approvals-inbox] tenant unavailable', { tenantId: tenants[i].id, err: r.reason });
    unavailableTenants.push(tenants[i].id);
  });
  return { items: items.sort(byCreatedAtDesc), unavailableTenants };
}
