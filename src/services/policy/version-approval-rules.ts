/**
 * 策略版本审批规则（纯函数，无服务端依赖，服务端审批与界面提示共用）。
 *
 * 谁能审批某个待审批版本，由两条规则共同决定：
 *   1. 归属：只有策略所有者能操作该策略的版本（assertPolicyOwnership，见 version-manager）；
 *   2. 四眼原则：版本作者不能审批自己创建的版本（本模块）。
 * 审批收件箱据此列出「可审批」与「等待他人审批」两类条目，approveVersion 据此拒绝自审。
 */

/** 四眼原则：审批人就是版本作者时属于自审，必须拒绝。 */
export function isSelfApproval(createdBy: string | null | undefined, approverId: string): boolean {
  return createdBy === approverId;
}
