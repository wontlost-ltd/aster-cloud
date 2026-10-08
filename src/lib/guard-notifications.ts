/**
 * guard 审批站内通知（ADR 0042 §5.3）。
 *
 * 只发站内通知、不发邮件；全部 fire-and-forget——通知失败只记日志，绝不影响触发它的执行或审批。
 */
import { and, arrayContains, eq, sql } from 'drizzle-orm';
import { createNotification, type GuardApprovalNotification } from '@/lib/notifications';
import { isPersonalTenant, policyTenantId } from '@/lib/policy-tenant';
import { db, executions, policies, teamMembers } from '@/lib/prisma';

/**
 * 待审批收件人：个人租户（与业务角色读取同一判定）只有所有者本人；
 * 团队租户按 requiredRole 精确匹配成员业务角色（null=ESCALATE 全员）。
 */
async function approvalRecipients(
  tenantId: string,
  policyOwnerId: string,
  requiredRole: string | null
): Promise<string[]> {
  if (isPersonalTenant(tenantId, policyOwnerId)) return [policyOwnerId];
  const byTeam = eq(teamMembers.teamId, tenantId);
  const rows = await db.query.teamMembers.findMany({
    where: requiredRole == null ? byTeam : and(byTeam, arrayContains(teamMembers.businessRoles, [requiredRole])),
    columns: { userId: true },
  });
  return rows.map((r) => r.userId);
}

/** 待审批通知：租户取 payload.tenantId，policyOwnerId 用于判定个人租户。 */
export async function notifyApprovalRequested(
  policyOwnerId: string,
  payload: GuardApprovalNotification
): Promise<void> {
  const tenantId = payload.tenantId;
  try {
    const recipients = await approvalRecipients(tenantId, policyOwnerId, payload.requiredRole);
    await Promise.all(
      recipients.map((userId) => createNotification({ userId, kind: 'guard.approval_requested', data: payload }))
    );
  } catch (err) {
    console.error('[guard-notifications] approval_requested failed', { tenantId, decisionId: payload.decisionId, err });
  }
}

/**
 * 决策的发起执行：执行路由把 guardDecisionId 写进 executions.metadata（json 列，有表达式索引 0052），
 * 按该键反查发起人与策略。同一决策只会由一次执行登记（from-evidence 幂等），取首行即可。
 * 纵深防御：策略须属于审批所在租户，否则视为查不到（返回 null），不向他租户的执行人发通知。
 */
export async function findExecutionByGuardDecision(
  decisionId: string,
  tenantId: string
): Promise<{ userId: string; policyId: string; policyName: string } | null> {
  const exec = await db.query.executions.findFirst({
    where: sql`${executions.metadata}->>'guardDecisionId' = ${decisionId}`,
    columns: { userId: true, policyId: true },
  });
  if (!exec) return null;
  const policy = await db.query.policies.findFirst({
    where: eq(policies.id, exec.policyId),
    columns: { name: true, teamId: true, userId: true },
  });
  if (!policy || policyTenantId(policy) !== tenantId) return null;
  return { userId: exec.userId, policyId: exec.policyId, policyName: policy.name };
}

/** 审批已决：通知发起执行的用户；找不到发起执行（如 SDK 直调 guard 开的决策）则不通知。 */
export async function notifyApprovalDecided(
  payload: Omit<GuardApprovalNotification, 'policyId' | 'policyName'> & { outcome: 'APPROVED' | 'REJECTED' }
): Promise<void> {
  try {
    const exec = await findExecutionByGuardDecision(payload.decisionId, payload.tenantId);
    if (!exec) return;
    await createNotification({
      userId: exec.userId,
      kind: 'guard.approval_decided',
      data: { ...payload, policyId: exec.policyId, policyName: exec.policyName },
    });
  } catch (err) {
    console.error('[guard-notifications] approval_decided failed', { decisionId: payload.decisionId, err });
  }
}
