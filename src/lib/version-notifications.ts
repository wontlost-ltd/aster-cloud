/**
 * 策略版本审批的站内通知（#678）。
 *
 * 与 guard 动作审批（guard-notifications.ts）对应：提交审批时通知能审批的人，审批结论通知版本作者
 * （驳回带理由——驳回对话框承诺「作者会看到你的说明」）。只发站内通知、不发邮件；
 * 全部 fire-and-forget，通知失败只记日志，不影响提交或审批本身。
 */
import { and, eq } from 'drizzle-orm';
import { createNotification } from '@/lib/notifications';
import { loadPolicyForAction } from '@/lib/policy-access';
import { db, policies, policyVersions } from '@/lib/prisma';
import { loadTeamReviewerIds } from '@/services/policy/version-manager';

/** 版本作者（policyVersions.createdBy）；版本不存在或无作者返回 null。 */
async function versionAuthorId(policyId: string, version: number): Promise<string | null> {
  const row = await db.query.policyVersions.findFirst({
    where: and(eq(policyVersions.policyId, policyId), eq(policyVersions.version, version)),
    columns: { createdBy: true },
  });
  return row?.createdBy ?? null;
}

/**
 * 提交审批：团队策略通知团队 owner / admin，不含提交者与版本作者——四眼原则下两者都不能审该版本，
 * 通知只是噪音（#701）。个人策略由所有者自审，没有其他人可通知。
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
    const authorId = await versionAuthorId(policyId, version);
    const reviewers = (await loadTeamReviewerIds(policy.teamId)).filter((id) => id !== submitterId && id !== authorId);
    const data = { policyId, policyName: policy.name, version, teamId: policy.teamId };
    await Promise.all(
      reviewers.map((userId) => createNotification({ userId, kind: 'policy.version_submitted', data })),
    );
  } catch (err) {
    console.error('[version-notifications] version_submitted failed', { policyId, version, err });
  }
}

/**
 * 审批结论：通知版本作者；审批人即作者（个人策略自审）时不通知。
 * 作者当前须仍能查看该策略：离队 / 被移除后不再收到含策略名与驳回理由的通知（#670「离队即无访问」，#701）。
 */
export async function notifyVersionDecided(params: {
  policyId: string;
  version: number;
  reviewerId: string;
  outcome: 'APPROVED' | 'REJECTED';
  comment?: string;
}): Promise<void> {
  const { policyId, version, reviewerId, outcome } = params;
  try {
    const authorId = await versionAuthorId(policyId, version);
    if (!authorId || authorId === reviewerId) return;
    const access = await loadPolicyForAction(policyId, { userId: authorId }, 'view');
    if (!access.ok) return;
    const comment = params.comment?.trim();
    await createNotification({
      userId: authorId,
      kind: 'policy.version_decided',
      data: {
        policyId,
        policyName: access.policy.name,
        version,
        outcome,
        ...(comment ? { comment } : {}),
      },
    });
  } catch (err) {
    console.error('[version-notifications] version_decided failed', { policyId, version, err });
  }
}
