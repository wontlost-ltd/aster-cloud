/**
 * 团队角色-权限矩阵（纯数据 + 纯函数，不依赖数据库）。
 *
 * 从 team-permissions.ts 拆出，供客户端组件按角色决定是否发起需要权限的请求
 * （#588：团队页对无 INVITATION_VIEW 权限的成员也请求 invitations，必然 403）。
 * 服务端仍以 team-permissions.ts 为入口，它原样再导出这里的定义。
 */

// 权限定义
export const TeamPermission = {
  TEAM_VIEW: 'team.view',
  TEAM_UPDATE: 'team.update',
  TEAM_DELETE: 'team.delete',
  TEAM_TRANSFER: 'team.transfer',
  // 设置团队向用户开放的 UI 语言白名单（owner/admin）。
  TEAM_UPDATE_LOCALES: 'team.updateLocales',
  MEMBER_VIEW: 'member.view',
  MEMBER_INVITE: 'member.invite',
  MEMBER_REMOVE: 'member.remove',
  MEMBER_UPDATE_ROLE: 'member.updateRole',
  POLICY_VIEW: 'policy.view',
  POLICY_CREATE: 'policy.create',
  POLICY_UPDATE: 'policy.update',
  POLICY_DELETE: 'policy.delete',
  POLICY_EXECUTE: 'policy.execute',
  // 批准 / 驳回团队策略的待审批版本（另叠加四眼原则：版本作者不能审批自己的版本）。
  POLICY_APPROVE: 'policy.approve',
  // 切换策略公开状态（isPublic）：公开会把团队策略源码与执行入口暴露给全平台，只给 owner/admin。
  POLICY_PUBLISH: 'policy.publish',
  INVITATION_VIEW: 'invitation.view',
  INVITATION_CREATE: 'invitation.create',
  INVITATION_REVOKE: 'invitation.revoke',
} as const;

export type TeamPermissionType = (typeof TeamPermission)[keyof typeof TeamPermission];

// 角色层级（用于比较）
export const ROLE_HIERARCHY = ['viewer', 'member', 'admin', 'owner'] as const;
export type TeamRole = (typeof ROLE_HIERARCHY)[number];

// 角色-权限矩阵
export const ROLE_PERMISSIONS: Record<string, TeamPermissionType[]> = {
  owner: Object.values(TeamPermission),
  admin: [
    TeamPermission.TEAM_VIEW,
    TeamPermission.TEAM_UPDATE,
    TeamPermission.TEAM_UPDATE_LOCALES,
    TeamPermission.MEMBER_VIEW,
    TeamPermission.MEMBER_INVITE,
    TeamPermission.MEMBER_REMOVE,
    TeamPermission.MEMBER_UPDATE_ROLE,
    TeamPermission.POLICY_VIEW,
    TeamPermission.POLICY_CREATE,
    TeamPermission.POLICY_UPDATE,
    TeamPermission.POLICY_DELETE,
    TeamPermission.POLICY_EXECUTE,
    TeamPermission.POLICY_APPROVE,
    TeamPermission.POLICY_PUBLISH,
    TeamPermission.INVITATION_VIEW,
    TeamPermission.INVITATION_CREATE,
    TeamPermission.INVITATION_REVOKE,
  ],
  member: [
    TeamPermission.TEAM_VIEW,
    TeamPermission.MEMBER_VIEW,
    TeamPermission.POLICY_VIEW,
    TeamPermission.POLICY_CREATE,
    TeamPermission.POLICY_UPDATE,
    TeamPermission.POLICY_EXECUTE,
  ],
  viewer: [TeamPermission.TEAM_VIEW, TeamPermission.MEMBER_VIEW, TeamPermission.POLICY_VIEW],
};

// 检查角色是否拥有指定权限
export function hasPermission(role: TeamRole, permission: TeamPermissionType): boolean {
  const permissions = ROLE_PERMISSIONS[role] ?? [];
  return permissions.includes(permission);
}

// 拥有指定权限的全部角色（按层级从低到高），供 SQL 按角色集合过滤成员行
export function rolesWithPermission(permission: TeamPermissionType): TeamRole[] {
  return ROLE_HIERARCHY.filter((role) => hasPermission(role, permission));
}

// 获取角色层级
export function getRoleLevel(role: TeamRole): number {
  return ROLE_HIERARCHY.indexOf(role);
}
