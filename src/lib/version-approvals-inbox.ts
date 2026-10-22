/**
 * 审批收件箱里的「策略版本审批」（生产 E2E Q1）。
 *
 * 收件箱原本只聚合 Action-Guard 审批；版本提交审批（「提交审批」→「等待他人审批」）此前只能在
 * 各策略的版本页里看到。这里按与 approveVersion 完全相同的规则（decideVersionApproval）列出待审批版本：
 *   - 范围 = 用户名下未删除的策略 ∪ 用户担任 owner/admin 的团队的未删除策略；
 *   - canAct = 审批规则允许：团队策略的团队 owner/admin 且不是作者；个人策略的所有者（可自审）。
 *     不能审批的（如团队策略的作者本人）照样列出但只读，标注「等待他人审批」。
 * 审批动作本身不在这里：条目链接到既有的版本页，由那里的批准/驳回走 approveVersion。
 */
import 'server-only';

import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db, policies, policyVersions, securityEvents, teamMembers, users } from '@/lib/prisma';
import type { TeamRole } from '@/lib/team-permissions';
import {
  decideVersionApproval,
  lacksEligibleReviewer,
  TEAM_REVIEWER_ROLES,
} from '@/services/policy/version-approval-rules';

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
  /** 策略所属团队；个人策略为 null。 */
  teamId: string | null;
  /** 团队策略里除作者外没有任何 owner/admin，四眼原则下无人能审批（界面提示任命管理员）。 */
  noEligibleReviewer: boolean;
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

/** 用户在各团队的角色，只保留能审批团队策略版本的 owner/admin。 */
async function loadReviewerTeamRoles(userId: string): Promise<Map<string, TeamRole>> {
  const memberships = await db.query.teamMembers.findMany({
    where: and(eq(teamMembers.userId, userId), inArray(teamMembers.role, ['owner', 'admin'])),
    columns: { teamId: true, role: true },
  });
  return new Map(memberships.map((m) => [m.teamId, m.role as TeamRole]));
}

/** 各团队全部 owner/admin 的用户 id，用于判断待审批版本是否还有合格审批人。 */
async function loadTeamReviewerIds(teamIds: string[]): Promise<Map<string, string[]>> {
  const byTeam = new Map<string, string[]>();
  if (teamIds.length === 0) return byTeam;
  const rows = await db.query.teamMembers.findMany({
    where: and(inArray(teamMembers.teamId, teamIds), inArray(teamMembers.role, [...TEAM_REVIEWER_ROLES])),
    columns: { teamId: true, userId: true },
  });
  for (const r of rows) byTeam.set(r.teamId, [...(byTeam.get(r.teamId) ?? []), r.userId]);
  return byTeam;
}

export async function listPendingVersionApprovals(userId: string): Promise<PendingVersionApproval[]> {
  const teamRoles = await loadReviewerTeamRoles(userId);
  const reviewerTeams = [...teamRoles.keys()];
  const owned = await db.query.policies.findMany({
    where: and(
      reviewerTeams.length > 0
        ? or(eq(policies.userId, userId), inArray(policies.teamId, reviewerTeams))
        : eq(policies.userId, userId),
      isNull(policies.deletedAt),
    ),
    columns: { id: true, name: true, userId: true, teamId: true },
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
  const policyById = new Map(owned.map((p) => [p.id, p]));
  const pendingTeamIds = [
    ...new Set(pending.map((v) => policyById.get(v.policyId)?.teamId).filter((id): id is string => !!id)),
  ];
  const [names, reviewersByTeam] = await Promise.all([
    loadDisplayNames(submitterIds),
    loadTeamReviewerIds(pendingTeamIds),
  ]);

  return pending
    .map((v) => {
      const submitter = submitterOf(v);
      const policy = policyById.get(v.policyId);
      const verdict = decideVersionApproval({
        policyOwnerId: policy?.userId ?? '',
        policyTeamId: policy?.teamId ?? null,
        reviewerId: userId,
        reviewerTeamRole: policy?.teamId ? (teamRoles.get(policy.teamId) ?? null) : null,
        versionAuthorId: v.createdBy,
      });
      return {
        versionId: v.id,
        policyId: v.policyId,
        policyName: policy?.name ?? v.policyId,
        version: v.version,
        submittedBy: submitter ? (names.get(submitter) ?? null) : null,
        submittedAt: (events.get(`${v.policyId}:${v.version}`)?.createdAt ?? v.createdAt).toISOString(),
        canAct: verdict.allowed,
        teamId: policy?.teamId ?? null,
        noEligibleReviewer: lacksEligibleReviewer(
          policy?.teamId ?? null,
          policy?.teamId ? (reviewersByTeam.get(policy.teamId) ?? []) : [],
          v.createdBy,
        ),
      };
    })
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}
