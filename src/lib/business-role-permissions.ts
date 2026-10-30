/**
 * 业务角色的修改权限（纯函数，无服务端依赖：成员路由与成员页共用同一判定）。
 */
import type { TeamRole } from '@/lib/team-permissions';

export type BusinessRoleChangeCheck =
  | { allowed: true }
  | {
      allowed: false;
      error: string;
      code: 'cannot_modify_own_business_roles' | 'cannot_modify_owner' | 'admin_cannot_modify_admin';
      status: 403;
    };

/**
 * 谁能修改某个成员的业务角色（#676，最小权限）。
 *
 * 业务角色是按角色把关的审批（`Verdict.require_approval("Credit Officer", …)`）的唯一资格，
 * 能改业务角色就能给自己开审批资格、或撤掉别人的资格。所以沿用成员角色的层级约束：
 *   - owner 可改任何成员（含自己）——owner 本就能决定谁是审批人；
 *   - admin 只能改 member / viewer：不能改自己、owner，也不能改其他 admin。
 */
export function canChangeBusinessRoles(
  actorRole: TeamRole,
  targetRole: TeamRole,
  isSelf: boolean,
): BusinessRoleChangeCheck {
  if (actorRole === 'owner') return { allowed: true };
  if (isSelf) {
    return {
      allowed: false,
      error: 'You cannot change your own business roles. Ask the team owner.',
      code: 'cannot_modify_own_business_roles',
      status: 403,
    };
  }
  if (targetRole === 'owner') {
    return {
      allowed: false,
      error: "Only the owner can change the owner's business roles.",
      code: 'cannot_modify_owner',
      status: 403,
    };
  }
  if (targetRole === 'admin') {
    return {
      allowed: false,
      error: 'Admins cannot change the business roles of other admins.',
      code: 'admin_cannot_modify_admin',
      status: 403,
    };
  }
  return { allowed: true };
}
