/**
 * guard 审批站内通知（ADR 0042 §5.3）。
 *
 * 只发站内通知、不发邮件；全部 fire-and-forget——通知失败只记日志，绝不影响触发它的执行或审批。
 */
import { and, arrayContains, eq, sql } from 'drizzle-orm';
import { createNotification, type GuardApprovalNotification } from '@/lib/notifications';
import { db, executions, policies, teamMembers, teams } from '@/lib/prisma';

/**
 * 待审批收件人：团队租户按 requiredRole 精确匹配成员业务角色（null=ESCALATE 全员）；
 * 个人租户（tenantId 不是团队）只有本人。
 */
async function approvalRecipients(tenantId: string, requiredRole: string | null): Promise<string[]> {
  const team = await db.query.teams.findFirst({ where: eq(teams.id, tenantId), columns: { id: true } });
  if (!team) return [tenantId];
  const byTeam = eq(teamMembers.teamId, tenantId);
  const rows = await db.query.teamMembers.findMany({
    where: requiredRole == null ? byTeam : and(byTeam, arrayContains(teamMembers.businessRoles, [requiredRole])),
    columns: { userId: true },
  });
  return rows.map((r) => r.userId);
}

export async function notifyApprovalRequested(
  tenantId: string,
  payload: GuardApprovalNotification
): Promise<void> {
  try {
    const recipients = await approvalRecipients(tenantId, payload.requiredRole);
    await Promise.all(
      recipients.map((userId) => createNotification({ userId, kind: 'guard.approval_requested', data: payload }))
    );
  } catch (err) {
    console.error('[guard-notifications] approval_requested failed', { tenantId, decisionId: payload.decisionId, err });
  }
}

/**
 * 决策的发起执行：执行路由把 guardDecisionId 写进 executions.metadata（json 列），按该键反查发起人与策略。
 * 同一决策只会由一次执行登记（from-evidence 幂等），取首行即可；查不到返回 null。
 */
export async function findExecutionByGuardDecision(
  decisionId: string
): Promise<{ userId: string; policyId: string; policyName: string } | null> {
  const exec = await db.query.executions.findFirst({
    where: sql`${executions.metadata}->>'guardDecisionId' = ${decisionId}`,
    columns: { userId: true, policyId: true },
  });
  if (!exec) return null;
  const policy = await db.query.policies.findFirst({
    where: eq(policies.id, exec.policyId),
    columns: { name: true },
  });
  return { userId: exec.userId, policyId: exec.policyId, policyName: policy?.name ?? '' };
}

/** 审批已决：通知发起执行的用户；找不到发起执行（如 SDK 直调 guard 开的决策）则不通知。 */
export async function notifyApprovalDecided(
  payload: Omit<GuardApprovalNotification, 'policyId' | 'policyName'> & { outcome: 'APPROVED' | 'REJECTED' }
): Promise<void> {
  try {
    const exec = await findExecutionByGuardDecision(payload.decisionId);
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
