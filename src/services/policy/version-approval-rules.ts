/**
 * 策略版本审批规则（纯函数，无服务端依赖；服务端审批、审批收件箱与版本页共用同一判定）。
 *
 * 谁能批准/驳回一个待审批版本：
 *   - 团队策略（policy.teamId 非空）：该团队的 owner / admin，且不能是版本作者（四眼原则）。
 *     策略所有者若在团队里只是 member，同样不能审批。
 *   - 个人策略（无 teamId）：只有策略所有者能审批，允许审批自己提交的版本——单人账户没有第二个人，
 *     这类自审在审计事件里标记 selfApproved: true，界面上给出说明。
 * 套餐级的 SOX 要求（approvalRequired）由批准路由的 checkSoxGuard 另行叠加，不在本模块。
 */
import { rolesWithPermission, TeamPermission, type TeamRole } from '@/lib/team-permission-matrix';
import { decidePolicyAccess } from '@/lib/policy-access-matrix';

/** 能审批团队策略版本的团队角色（来自团队权限矩阵的 policy.approve）。 */
export const TEAM_REVIEWER_ROLES: readonly TeamRole[] = rolesWithPermission(TeamPermission.POLICY_APPROVE);

export interface VersionReviewContext {
  /** 策略所有者（policies.userId） */
  policyOwnerId: string;
  /** 策略所属团队；null = 个人策略 */
  policyTeamId: string | null;
  /** 审批人 */
  reviewerId: string;
  /** 审批人在策略所属团队中的角色；个人策略或非成员为 null */
  reviewerTeamRole: TeamRole | null;
}

/**
 * 审批人是否有权审阅（查看并批准/驳回）该策略的版本——与具体版本无关的那一半规则。
 * 无权者对外按「策略不存在」处理（404），不泄露策略是否存在。
 */
export function canReviewPolicyVersions(ctx: VersionReviewContext): boolean {
  return decidePolicyAccess({
    action: 'approve',
    actorId: ctx.reviewerId,
    policy: { userId: ctx.policyOwnerId, teamId: ctx.policyTeamId },
    teamRole: ctx.reviewerTeamRole,
  }).allowed;
}

export type VersionApprovalDecision =
  | { allowed: true; selfApproved: boolean }
  | { allowed: false; reason: 'not_authorized' | 'segregation_of_duties' };

/** 针对某个版本的完整判定：先看审阅权，再按策略类型应用四眼原则或个人自审。 */
export function decideVersionApproval(
  ctx: VersionReviewContext & { versionAuthorId: string | null },
): VersionApprovalDecision {
  if (!canReviewPolicyVersions(ctx)) return { allowed: false, reason: 'not_authorized' };
  const isAuthor = ctx.versionAuthorId === ctx.reviewerId;
  if (ctx.policyTeamId) {
    return isAuthor ? { allowed: false, reason: 'segregation_of_duties' } : { allowed: true, selfApproved: false };
  }
  return { allowed: true, selfApproved: isAuthor };
}

/**
 * 团队策略的待审批版本是否根本没有合格审批人：团队里除版本作者外没有任何 owner/admin。
 * 四眼原则不放宽（产品决定），界面据此提示把一位成员设为管理员，而不是只显示「等待他人审批」。
 * 个人策略恒为 false（所有者可自审）。
 *
 * @param teamReviewerIds 策略所属团队全部 owner/admin 的用户 id
 */
export function lacksEligibleReviewer(
  policyTeamId: string | null,
  teamReviewerIds: readonly string[],
  versionAuthorId: string | null,
): boolean {
  if (!policyTeamId) return false;
  return !teamReviewerIds.some((id) => id !== versionAuthorId);
}
