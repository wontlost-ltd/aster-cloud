/**
 * 安全事件的**展示类型**（F10）。
 *
 * 库里的 eventType 是写入方选的粗粒度枚举，有些枚举值下混着语义不同的动作：
 * - `APPROVAL_DECISION` 既记录审批人的决定，也记录作者「提交审批」（details.action =
 *   'SUBMIT_FOR_APPROVAL'）——提交不是决定，直接按 eventType 贴「审批决策」会误导；
 * - `POLICY_EXECUTED` 在执行抛错时也会写（details.error / success=false），贴「策略执行」
 *   看不出它失败了。
 *
 * 不改写入侧的枚举（要 DB 迁移，且历史行仍是旧值），而是在展示层按 details 细分。
 * 列表与「事件类型分布」统计必须共用这一个函数，否则两处口径会不一致。
 */

/** 由 details 细分出来的展示类型（不在 DB 枚举里）。 */
export const DERIVED_SECURITY_EVENT_TYPES = ['APPROVAL_SUBMITTED', 'POLICY_EXECUTION_FAILED'] as const;

/** 细分判定只依赖 details 里的这几个字段。 */
export interface SecurityEventDisplayDetails {
  action?: unknown;
  success?: unknown;
  error?: unknown;
}

export function securityEventDisplayType(
  eventType: string,
  details: SecurityEventDisplayDetails | null | undefined,
): string {
  if (eventType === 'APPROVAL_DECISION' && details?.action === 'SUBMIT_FOR_APPROVAL') {
    return 'APPROVAL_SUBMITTED';
  }
  if (eventType === 'POLICY_EXECUTED' && (details?.success === false || details?.error != null)) {
    return 'POLICY_EXECUTION_FAILED';
  }
  if (eventType === 'VERSION_CREATED' && typeof details?.action === 'string') {
    const adminActions = new Set([
      'API_KEY_CREATED', 'API_KEY_REVOKED', 'TEAM_CREATED', 'TEAM_DELETED',
      'TEAM_OWNERSHIP_TRANSFERRED', 'TEAM_MEMBER_REMOVED', 'TEAM_MEMBER_BUSINESS_ROLES_UPDATED', 'POLICY_TRASHED',
      'POLICY_RESTORED', 'POLICY_PERMANENTLY_DELETED',
    ]);
    if (adminActions.has(details.action)) return details.action;
  }
  return eventType;
}
