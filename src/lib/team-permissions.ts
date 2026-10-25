import { db, teamMembers } from '@/lib/prisma';
import { eq, and } from 'drizzle-orm';
import {
  getRoleLevel,
  hasPermission,
  type TeamPermissionType,
  type TeamRole,
} from './team-permission-matrix';

export {
  ROLE_HIERARCHY,
  ROLE_PERMISSIONS,
  TeamPermission,
  getRoleLevel,
  hasPermission,
  type TeamPermissionType,
  type TeamRole,
} from './team-permission-matrix';

/**
 * 单用户租户（当前 tenantId === userId）下，API key 持有者对自己租户的角色。
 * 下发给 aster-api（apikey verify + snapshot），由其无条件覆盖 X-User-Role
 * 防止伪造提权（owner ≥ admin，满足审计端点的 ADMIN 要求）。引入真正的多租户
 * team 后，改为查 teamMembers.role 即可——这个常量是当前模型的单一真相源，
 * 类型受 TeamRole 约束，避免字符串字面量在多处静默漂移。
 */
export const SOLO_TENANT_ROLE: TeamRole = 'owner';

// 结果类型（判别联合模式）
/**
 * 拒绝原因码：前端据此本地化，API 的 `error` 文案为英文兜底（#588：此前文案硬编码中文，
 * 英文界面上原样显示「你不是此团队的成员」）。
 */
export type TeamPermissionErrorCode =
  | 'not_team_member'
  | 'insufficient_team_role'
  | 'cannot_modify_owner'
  | 'cannot_promote_to_owner'
  | 'admin_cannot_modify_admin'
  | 'cannot_assign_equal_or_higher_role'
  | 'owner_cannot_leave'
  | 'cannot_remove_owner'
  | 'admin_cannot_remove_admin'
  | 'cannot_invite_as_owner'
  | 'cannot_invite_equal_or_higher_role';

type Denied = { allowed: false; error: string; code: TeamPermissionErrorCode; status: number };

export type TeamAccessResult = { allowed: true; role: TeamRole; teamId: string } | Denied;

export type PermissionCheckResult = { allowed: true } | Denied;

// 获取用户在团队中的角色
export async function getTeamMemberRole(userId: string, teamId: string): Promise<TeamRole | null> {
  const membership = await db.query.teamMembers.findFirst({
    where: and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)),
    columns: { role: true },
  });
  return (membership?.role as TeamRole) ?? null;
}

// 检查用户是否有权访问团队
export async function checkTeamAccess(userId: string, teamId: string): Promise<TeamAccessResult> {
  const role = await getTeamMemberRole(userId, teamId);

  if (!role) {
    return {
      allowed: false,
      error: 'You are not a member of this team.',
      code: 'not_team_member',
      status: 403,
    };
  }

  return { allowed: true, role, teamId };
}

// 综合检查：团队访问权限 + 具体权限
export async function checkTeamPermission(
  userId: string,
  teamId: string,
  permission: TeamPermissionType
): Promise<PermissionCheckResult> {
  const access = await checkTeamAccess(userId, teamId);

  if (!access.allowed) {
    return access;
  }

  if (!hasPermission(access.role, permission)) {
    return {
      allowed: false,
      error: `Insufficient team role: ${permission} requires a higher role.`,
      code: 'insufficient_team_role',
      status: 403,
    };
  }

  return { allowed: true };
}

// 验证角色变更（用于成员角色更新）
export function canChangeRole(
  actorRole: TeamRole,
  targetCurrentRole: TeamRole,
  targetNewRole: TeamRole
): PermissionCheckResult {
  // 不能修改 Owner 角色
  if (targetCurrentRole === 'owner') {
    return {
      allowed: false,
      error: 'The owner role cannot be changed. Use ownership transfer instead.',
      code: 'cannot_modify_owner',
      status: 403,
    };
  }

  // 不能提升为 Owner
  if (targetNewRole === 'owner') {
    return {
      allowed: false,
      error: 'Members cannot be promoted to owner. Use ownership transfer instead.',
      code: 'cannot_promote_to_owner',
      status: 403,
    };
  }

  // Admin 不能修改其他 Admin
  if (actorRole === 'admin' && targetCurrentRole === 'admin') {
    return {
      allowed: false,
      error: 'Admins cannot change the role of other admins.',
      code: 'admin_cannot_modify_admin',
      status: 403,
    };
  }

  const actorLevel = getRoleLevel(actorRole);
  const newLevel = getRoleLevel(targetNewRole);

  // 非 Owner 不能分配等于或高于自己的角色
  if (actorRole !== 'owner' && newLevel >= actorLevel) {
    return {
      allowed: false,
      error: 'You cannot assign a role equal to or higher than your own.',
      code: 'cannot_assign_equal_or_higher_role',
      status: 403,
    };
  }

  return { allowed: true };
}

// 检查是否可以移除成员
export function canRemoveMember(
  actorRole: TeamRole,
  targetRole: TeamRole,
  isSelf: boolean
): PermissionCheckResult {
  // Owner 不能离开团队
  if (isSelf && targetRole === 'owner') {
    return {
      allowed: false,
      error: 'The owner cannot leave the team. Transfer ownership first.',
      code: 'owner_cannot_leave',
      status: 403,
    };
  }

  // 不能移除 Owner
  if (targetRole === 'owner') {
    return {
      allowed: false,
      error: 'The team owner cannot be removed.',
      code: 'cannot_remove_owner',
      status: 403,
    };
  }

  // Admin 不能移除其他 Admin
  if (actorRole === 'admin' && targetRole === 'admin' && !isSelf) {
    return {
      allowed: false,
      error: 'Admins cannot remove other admins.',
      code: 'admin_cannot_remove_admin',
      status: 403,
    };
  }

  return { allowed: true };
}

// 检查邀请角色是否有效
export function canInviteWithRole(
  inviterRole: TeamRole,
  inviteeRole: TeamRole
): PermissionCheckResult {
  // 不能邀请为 Owner
  if (inviteeRole === 'owner') {
    return {
      allowed: false,
      error: 'Users cannot be invited as owner.',
      code: 'cannot_invite_as_owner',
      status: 403,
    };
  }

  const inviterLevel = getRoleLevel(inviterRole);
  const inviteeLevel = getRoleLevel(inviteeRole);

  // 非 Owner 不能邀请等于或高于自己角色的人
  if (inviterRole !== 'owner' && inviteeLevel >= inviterLevel) {
    return {
      allowed: false,
      error: 'You cannot invite someone with a role equal to or higher than your own.',
      code: 'cannot_invite_equal_or_higher_role',
      status: 403,
    };
  }

  return { allowed: true };
}
