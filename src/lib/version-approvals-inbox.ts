/**
 * 审批收件箱里的「策略版本审批」（生产 E2E Q1）。
 *
 * 收件箱原本只聚合 Action-Guard 审批；版本提交审批（「提交审批」→「等待他人审批」）此前只能在
 * 各策略的版本页里看到。这里按与 approveVersion 完全相同的规则列出待审批版本：
 *   - 范围 = 用户名下未删除的策略（同 assertPolicyOwnership，非所有者本就无权操作）；
 *   - canAct = 不是版本作者（四眼原则，isSelfApproval）。作者自己的提交照样列出，但只读，
 *     标注「等待他人审批」，让提交人在收件箱里也能看到自己的提交。
 * 审批动作本身不在这里：条目链接到既有的版本页，由那里的批准/驳回走 approveVersion。
 */
import 'server-only';

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, policies, policyVersions, securityEvents, users } from '@/lib/prisma';
import { isSelfApproval } from '@/services/policy/version-approval-rules';

export interface PendingVersionApproval {
  versionId: string;
  policyId: string;
  policyName: string;
  version: number;
  /** 提交人显示名（姓名，否则邮箱）；查不到为 null。 */
  submittedBy: string | null;
  /** 提交时间（ISO）；取最近一次提交审批事件，事件缺失时退回版本创建时间。 */
  submittedAt: string;
  canAct: boolean;
}

interface SubmitEvent {
  userId: string | null;
  createdAt: Date;
}

/** 最近一次「提交审批」安全事件，按 policyId:version 索引（事件已按时间倒序）。 */
async function loadSubmitEvents(policyIds: string[]): Promise<Map<string, SubmitEvent>> {
  const events = await db.query.securityEvents.findMany({
    where: and(
      inArray(securityEvents.policyId, policyIds),
      eq(securityEvents.eventType, 'APPROVAL_DECISION'),
      sql`${securityEvents.details}->>'action' = 'SUBMIT_FOR_APPROVAL'`,
    ),
    columns: { policyId: true, userId: true, details: true, createdAt: true },
    orderBy: [desc(securityEvents.createdAt)],
  });
  const latest = new Map<string, SubmitEvent>();
  for (const e of events) {
    const key = `${e.policyId}:${(e.details as { version?: unknown }).version}`;
    if (!latest.has(key)) latest.set(key, { userId: e.userId, createdAt: e.createdAt });
  }
  return latest;
}

async function loadDisplayNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.query.users.findMany({
    where: inArray(users.id, ids),
    columns: { id: true, name: true, email: true },
  });
  return new Map(rows.map((u) => [u.id, u.name || u.email || u.id]));
}

export async function listPendingVersionApprovals(userId: string): Promise<PendingVersionApproval[]> {
  const owned = await db.query.policies.findMany({
    where: and(eq(policies.userId, userId), isNull(policies.deletedAt)),
    columns: { id: true, name: true },
  });
  if (owned.length === 0) return [];

  const pending = await db.query.policyVersions.findMany({
    where: and(
      inArray(policyVersions.policyId, owned.map((p) => p.id)),
      eq(policyVersions.status, 'PENDING_APPROVAL'),
    ),
    columns: { id: true, policyId: true, version: true, createdBy: true, createdAt: true },
  });
  if (pending.length === 0) return [];

  const events = await loadSubmitEvents([...new Set(pending.map((v) => v.policyId))]);
  const submitterOf = (v: (typeof pending)[number]) => events.get(`${v.policyId}:${v.version}`)?.userId ?? v.createdBy;
  const submitterIds = [...new Set(pending.map(submitterOf).filter((id): id is string => !!id))];
  const names = await loadDisplayNames(submitterIds);
  const policyName = new Map(owned.map((p) => [p.id, p.name]));

  return pending
    .map((v) => {
      const submitter = submitterOf(v);
      return {
        versionId: v.id,
        policyId: v.policyId,
        policyName: policyName.get(v.policyId) ?? v.policyId,
        version: v.version,
        submittedBy: submitter ? (names.get(submitter) ?? null) : null,
        submittedAt: (events.get(`${v.policyId}:${v.version}`)?.createdAt ?? v.createdAt).toISOString(),
        canAct: !isSelfApproval(v.createdBy, userId),
      };
    })
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}
