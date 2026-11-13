/**
 * 签发方管理的租户权限（ADR 0040 §11 D3，不新增权限常量）：
 * 读 = 个人租户本人或团队 TEAM_VIEW；写 / 吊销 = 个人租户本人或团队 MEMBER_UPDATE_ROLE（admin / owner）。
 * 吊销会联动拒绝依赖该签发方的待审批，影响面与改成员角色相当，故沿用同一权限。
 * 非成员（含他人的个人租户）两者皆 false。
 */
import { isPersonalTenant } from '@/lib/policy-tenant';
import { checkTeamPermission, TeamPermission, type TeamPermissionType } from '@/lib/team-permissions';

async function allowed(userId: string, tenantId: string, permission: TeamPermissionType): Promise<boolean> {
  if (isPersonalTenant(tenantId, userId)) return true;
  return (await checkTeamPermission(userId, tenantId, permission)).allowed;
}

export function canViewFactIssuers(userId: string, tenantId: string): Promise<boolean> {
  return allowed(userId, tenantId, TeamPermission.TEAM_VIEW);
}

export function canManageFactIssuers(userId: string, tenantId: string): Promise<boolean> {
  return allowed(userId, tenantId, TeamPermission.MEMBER_UPDATE_ROLE);
}
