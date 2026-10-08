/**
 * guard 审批站内通知（ADR 0042 §5.3）。
 *
 * 只发站内通知、不发邮件；全部 fire-and-forget——通知失败只记日志，绝不影响触发它的执行或审批。
 */
import { and, arrayContains, eq } from 'drizzle-orm';
import { createNotification, type GuardApprovalNotification } from '@/lib/notifications';
import { db, teamMembers, teams } from '@/lib/prisma';

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
