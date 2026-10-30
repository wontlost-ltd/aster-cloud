/**
 * 策略版本审批的站内通知（#678）。
 *
 * 与 guard 动作审批（guard-notifications.ts）对应：提交审批时通知能审批的人，审批结论通知版本作者
 * （驳回带理由——驳回对话框承诺「作者会看到你的说明」）。只发站内通知、不发邮件；
 * 全部 fire-and-forget，通知失败只记日志，不影响提交或审批本身。
 */
import { and, eq } from 'drizzle-orm';
import { createNotification } from '@/lib/notifications';
import { db, policies, policyVersions } from '@/lib/prisma';
import { loadTeamReviewerIds } from '@/services/policy/version-manager';

/**
 * 提交审批：团队策略通知团队 owner / admin（不含提交者，四眼原则下提交者不能审）。
 * 个人策略由所有者自审，没有其他人可通知。
 */
export async function notifyVersionSubmitted(params: {
  policyId: string;
  version: number;
  submitterId: string;
}): Promise<void> {
  const { policyId, version, submitterId } = params;
  try {
    const policy = await db.query.policies.findFirst({
      where: eq(policies.id, policyId),
      columns: { name: true, teamId: true },
    });
    if (!policy?.teamId) return;
    const reviewers = (await loadTeamReviewerIds(policy.teamId)).filter((id) => id !== submitterId);
    const data = { policyId, policyName: policy.name, version, teamId: policy.teamId };
    await Promise.all(
      reviewers.map((userId) => createNotification({ userId, kind: 'policy.version_submitted', data })),
    );
  } catch (err) {
    console.error('[version-notifications] version_submitted failed', { policyId, version, err });
  }
}

/** 审批结论：通知版本作者；审批人即作者（个人策略自审）时不通知。 */
export async function notifyVersionDecided(params: {
  policyId: string;
  version: number;
  reviewerId: string;
  outcome: 'APPROVED' | 'REJECTED';
  comment?: string;
}): Promise<void> {
  const { policyId, version, reviewerId, outcome } = params;
  try {
    const target = await db.query.policyVersions.findFirst({
      where: and(eq(policyVersions.policyId, policyId), eq(policyVersions.version, version)),
      columns: { createdBy: true },
    });
    if (!target?.createdBy || target.createdBy === reviewerId) return;
    const policy = await db.query.policies.findFirst({
      where: eq(policies.id, policyId),
      columns: { name: true },
    });
    const comment = params.comment?.trim();
    await createNotification({
      userId: target.createdBy,
      kind: 'policy.version_decided',
      data: {
        policyId,
        policyName: policy?.name ?? '',
        version,
        outcome,
        ...(comment ? { comment } : {}),
      },
    });
  } catch (err) {
    console.error('[version-notifications] version_decided failed', { policyId, version, err });
  }
}
