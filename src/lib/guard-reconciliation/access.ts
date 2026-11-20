/**
 * Guard 对账的访问判定与签真实角色的客户端工厂（ADR 0061 §3.1 / §3.2）。
 *
 * - 看（摘要、列表、决策上下文）= 个人租户本人，或团队角色 ≥ member；确认 = 个人租户本人，或团队角色 ≥ admin。
 *   只比角色等级（getRoleLevel），不新增 TeamPermission 常量；viewer 与非成员看不到（ADR 0061 Q1）。
 * - 这是 cloud 唯一以非 `member` 角色签 aster-api 请求的地方：角色只由服务端会话 + 现查（freshDb）得出，
 *   个人租户取 SOLO_TENANT_ROLE（owner），请求体 / 查询串里的任何角色字段都不参与。
 * - createReconciliationClient 每个请求在路由处理函数内调用一次，不缓存、不放模块作用域：被降级的管理员
 *   下一次请求就按新角色判定。它不返回 PolicyApiClient，只返回窄接口 ReconciliationApi——带 admin / owner
 *   签名的客户端闭包在内，aster-api 的其他 ADMIN 端点（审计、分析等）因此结构上不可达。
 *   `role-scope.test.ts` 以源码扫描钉住「只有本文件以非缺省角色构造客户端」。
 */
import 'server-only';

import { eq } from 'drizzle-orm';
import { freshDb } from '@/db/fresh-read';
import { createPolicyApiClientForUser } from '@/lib/policy-api-identity';
import { isPersonalTenant } from '@/lib/policy-tenant';
import { teamMembers } from '@/lib/prisma';
import {
  getRoleLevel,
  getTeamMemberRole,
  ROLE_HIERARCHY,
  SOLO_TENANT_ROLE,
  type TeamRole,
} from '@/lib/team-permissions';
import type {
  GuardDecision,
  GuardOrphan,
  GuardOrphanPage,
  GuardOrphanQuery,
  GuardReconciliationSummary,
} from '@/services/policy/guard-types';

export interface ReconciliationAccess {
  role: TeamRole;
  canView: boolean;
  canAck: boolean;
}

/** 对账可见的租户；name 为空串表示个人租户（UI 显示本地化的「个人」）。 */
export interface ReconciliationTenant {
  id: string;
  name: string;
  access: ReconciliationAccess;
}

/** 对账调用的窄接口：只有这四个方法，签名角色由工厂决定，调用方无法换角色或调用其他端点。 */
export interface ReconciliationApi {
  summary(): Promise<GuardReconciliationSummary>;
  listOrphans(q: GuardOrphanQuery): Promise<GuardOrphanPage>;
  ackOrphan(id: number, comment: string): Promise<GuardOrphan>;
  getDecision(id: string): Promise<GuardDecision>;
}

function isTeamRole(value: unknown): value is TeamRole {
  return typeof value === 'string' && (ROLE_HIERARCHY as readonly string[]).includes(value);
}

/** 由角色算权限；未知角色字符串（库里的脏值）按非成员处理。 */
function accessFor(role: unknown): ReconciliationAccess | null {
  if (!isTeamRole(role)) return null;
  const level = getRoleLevel(role);
  return { role, canView: level >= getRoleLevel('member'), canAck: level >= getRoleLevel('admin') };
}

/** 用户在该租户的对账权限；非成员（含他人的个人租户）→ null。团队角色每次现查。 */
export async function reconciliationAccess(userId: string, tenantId: string): Promise<ReconciliationAccess | null> {
  if (isPersonalTenant(tenantId, userId)) return accessFor(SOLO_TENANT_ROLE);
  return accessFor(await getTeamMemberRole(userId, tenantId));
}

/** 用户可看对账的租户：个人租户在前，其后为角色 ≥ member 的团队（成员关系与角色走 freshDb）。 */
export async function listReconciliationTenants(userId: string): Promise<ReconciliationTenant[]> {
  const memberships = await freshDb.query.teamMembers.findMany({
    where: eq(teamMembers.userId, userId),
    columns: { teamId: true, role: true },
    with: { team: { columns: { name: true } } },
  });
  const personal = accessFor(SOLO_TENANT_ROLE);
  const out: ReconciliationTenant[] = personal ? [{ id: userId, name: '', access: personal }] : [];
  for (const m of memberships) {
    const access = accessFor(m.role);
    if (access?.canView && m.teamId !== userId) {
      out.push({ id: m.teamId, name: m.team?.name ?? m.teamId, access });
    }
  }
  return out;
}

/**
 * 以用户在该租户的当前角色构造对账客户端；不可看 → null（调用方回 403，不调用 aster-api）。
 * 每请求调用一次；返回值不得缓存或跨请求复用。
 */
export async function createReconciliationClient(
  tenantId: string,
  userId: string,
): Promise<{ api: ReconciliationApi; access: ReconciliationAccess } | null> {
  const access = await reconciliationAccess(userId, tenantId);
  if (!access?.canView) return null;
  const client = await createPolicyApiClientForUser(tenantId, userId, access.role);
  const api: ReconciliationApi = Object.freeze({
    summary: () => client.getGuardReconciliation(),
    listOrphans: (q: GuardOrphanQuery) => client.listGuardOrphans(q),
    ackOrphan: (id: number, comment: string) => client.ackGuardOrphan(id, comment),
    getDecision: (id: string) => client.getGuardDecision(id),
  });
  return { api, access };
}
