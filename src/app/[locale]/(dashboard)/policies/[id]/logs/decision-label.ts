export type LogDecision = 'approved' | 'denied' | 'error' | 'indeterminate' | 'require_approval' | 'escalate' | null;

/** 将决策态映射到文案键，旧记录按 success 兼容。 */
export function decisionLabelKey(decision: LogDecision, success: boolean): string {
  if (decision) return decision;
  return success ? 'approved' : 'error';
}
