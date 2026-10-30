/**
 * 策略授权矩阵（纯函数，不依赖数据库，客户端与服务端共用）。
 *
 * 资源 × 动作 × 团队角色的唯一判定。规则：
 *   - 团队策略（teamId 非空）：一律按调用者**当前**在该团队的成员角色判定，创建者身份不放行任何动作。
 *     非成员（含已离队、被移除的创建者）→ 404，不泄露策略是否存在；成员但角色不够 → 403。
 *   - 个人策略（teamId 为空）：只有所有者（policies.userId）可操作，其余人 404。
 *     公开策略 / 团队分享（PolicyShare）的只读与执行授予由各入口在 404 之后另行叠加，不在本矩阵。
 *   - 团队作用域 API key（ADR 0015）：只能访问 key 所属团队的策略；其他团队策略与任何个人策略一律 404。
 *   - What-If（ADR 0034 §4 护栏 3、ADR 0016 §2）：批次租户为策略租户（团队策略 teamId，个人策略 userId），
 *     批次的 userId 为发起人；只有策略创建者能发起 / 查看，团队策略还要求创建者当前仍有执行权限。
 *
 * 动作与团队权限的对应见 POLICY_ACTION_PERMISSION；角色拥有哪些权限见 team-permission-matrix。
 * 完整矩阵与各入口的对应关系见 docs/architecture/decisions/0016-team-policy-authorization.md。
 */
import { hasPermission, TeamPermission, type TeamPermissionType, type TeamRole } from './team-permission-matrix';

/**
 * 策略动作。
 *   - view：详情、版本列表/详情/源码、执行日志与统计、证据导出、Cedar 导出、条件漏斗
 *   - execute：会话执行、API v1 执行、guard 登记
 *   - update：编辑、新建版本、提交审批、设默认版本、导入到团队
 *   - share：管理团队分享与复核人（ADR 0037 §15）
 *   - delete：移入回收站、从回收站恢复、永久删除、废弃 / 归档版本
 *   - approve：批准 / 驳回待审批版本（另叠加四眼原则，见 version-approval-rules）
 *   - whatif：发起 / 查看 What-If 批次
 */
export type PolicyAction = 'view' | 'execute' | 'update' | 'share' | 'delete' | 'approve' | 'whatif';

export const POLICY_ACTIONS: readonly PolicyAction[] = ['view', 'execute', 'update', 'share', 'delete', 'approve', 'whatif'];

export const POLICY_ACTION_PERMISSION: Record<PolicyAction, TeamPermissionType> = {
  view: TeamPermission.POLICY_VIEW,
  execute: TeamPermission.POLICY_EXECUTE,
  update: TeamPermission.POLICY_UPDATE,
  share: TeamPermission.POLICY_UPDATE,
  delete: TeamPermission.POLICY_DELETE,
  approve: TeamPermission.POLICY_APPROVE,
  whatif: TeamPermission.POLICY_EXECUTE,
};

export type PolicyAccessDeniedCode = 'policy_not_found' | 'insufficient_team_role' | 'whatif_owner_only';

export type PolicyAccessDecision =
  | { allowed: true; via: 'owner' | 'team'; teamRole: TeamRole | null }
  | { allowed: false; status: 403 | 404; code: PolicyAccessDeniedCode; error: string };

export interface PolicyAccessSubject {
  /** 策略创建者 / 个人策略所有者 */
  userId: string;
  /** 所属团队；null 或空串 = 个人策略（与 policyTenantId 同一口径） */
  teamId: string | null;
}

export interface PolicyAccessInput {
  action: PolicyAction;
  actorId: string;
  policy: PolicyAccessSubject;
  /** 调用者当前在 policy.teamId 中的角色；个人策略或非成员为 null */
  teamRole: TeamRole | null;
  /** 团队作用域 API key 所属团队；会话与个人 key 为 null */
  keyTeamId?: string | null;
}

export const POLICY_NOT_FOUND: PolicyAccessDecision = {
  allowed: false,
  status: 404,
  code: 'policy_not_found',
  error: 'Policy not found',
};

const INSUFFICIENT_ROLE: PolicyAccessDecision = {
  allowed: false,
  status: 403,
  code: 'insufficient_team_role',
  error: 'Your team role does not allow this action on the policy.',
};

const WHATIF_OWNER_ONLY: PolicyAccessDecision = {
  allowed: false,
  status: 403,
  code: 'whatif_owner_only',
  error: 'What-If replays only the policy creator\'s own executions, so only the creator can run it.',
};

/** 团队策略判定：teamId 为空串视同个人策略。 */
export function policyTeamIdOf(policy: PolicyAccessSubject): string | null {
  return policy.teamId || null;
}

export function decidePolicyAccess(input: PolicyAccessInput): PolicyAccessDecision {
  const { action, actorId, policy, teamRole } = input;
  const teamId = policyTeamIdOf(policy);
  const keyTeamId = input.keyTeamId || null;

  if (keyTeamId && keyTeamId !== teamId) return POLICY_NOT_FOUND;

  if (!teamId) {
    return policy.userId === actorId ? { allowed: true, via: 'owner', teamRole: null } : POLICY_NOT_FOUND;
  }

  if (!teamRole) return POLICY_NOT_FOUND;
  if (!hasPermission(teamRole, POLICY_ACTION_PERMISSION[action])) return INSUFFICIENT_ROLE;
  if (action === 'whatif' && policy.userId !== actorId) return WHATIF_OWNER_ONLY;
  return { allowed: true, via: 'team', teamRole };
}

/** 调用者对一条策略可做的动作清单（页面据此显示 / 隐藏按钮）。 */
export type PolicyCapabilities = Record<PolicyAction, boolean>;

export function policyCapabilities(input: Omit<PolicyAccessInput, 'action'>): PolicyCapabilities {
  const out = {} as PolicyCapabilities;
  for (const action of POLICY_ACTIONS) out[action] = decidePolicyAccess({ ...input, action }).allowed;
  return out;
}
