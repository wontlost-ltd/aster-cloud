/**
 * 策略授权的服务端入口：按调用者当前团队成员关系与角色判定（矩阵见 policy-access-matrix）。
 *
 * 所有按 policyId 操作策略的入口（页面、会话路由、API v1、团队 key）都经由这里，
 * 不再各自写 `eq(policies.userId, session.user.id)`——那种写法把团队策略交给创建者、
 * 把其他成员拒之门外（#669 / #670）。
 */
import { NextResponse } from 'next/server';
import { and, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db, policies, teamMembers } from '@/lib/prisma';
import { bypassQueryCache } from '@/db/fresh-read';
import { getTeamMemberRole, rolesWithPermission, type TeamRole } from '@/lib/team-permissions';
import {
  decidePolicyAccess,
  policyCapabilities,
  policyTeamIdOf,
  POLICY_ACTION_PERMISSION,
  POLICY_NOT_FOUND,
  type PolicyAccessDecision,
  type PolicyAccessSubject,
  type PolicyAction,
  type PolicyCapabilities,
} from '@/lib/policy-access-matrix';

export {
  decidePolicyAccess,
  POLICY_ACTION_PERMISSION,
  type PolicyAccessDecision,
  type PolicyAction,
  type PolicyCapabilities,
} from '@/lib/policy-access-matrix';

/** 发起操作的主体：会话用户，或 API key 持有者（团队 key 带 keyTeamId）。 */
export interface PolicyActor {
  userId: string;
  keyTeamId?: string | null;
}

type PolicyRow = typeof policies.$inferSelect;

/** 调用者在策略所属团队的当前角色；个人策略不查库。 */
async function teamRoleFor(actor: PolicyActor, policy: PolicyAccessSubject): Promise<TeamRole | null> {
  const teamId = policyTeamIdOf(policy);
  return teamId ? getTeamMemberRole(actor.userId, teamId) : null;
}

export async function authorizePolicyAction(
  actor: PolicyActor,
  policy: PolicyAccessSubject,
  action: PolicyAction,
): Promise<PolicyAccessDecision> {
  const teamRole = await teamRoleFor(actor, policy);
  return decidePolicyAccess({ action, actorId: actor.userId, policy, teamRole, keyTeamId: actor.keyTeamId });
}

/** 一次查角色，算出全部动作的可用性（页面渲染按钮用）。 */
export async function loadPolicyCapabilities(actor: PolicyActor, policy: PolicyAccessSubject): Promise<PolicyCapabilities> {
  const teamRole = await teamRoleFor(actor, policy);
  return policyCapabilities({ actorId: actor.userId, policy, teamRole, keyTeamId: actor.keyTeamId });
}

export type LoadedPolicy =
  | { ok: true; policy: PolicyRow; decision: Extract<PolicyAccessDecision, { allowed: true }> }
  | { ok: false; decision: Extract<PolicyAccessDecision, { allowed: false }> };

/**
 * 按 id 取策略并授权。默认只取未删除的策略；`deleted: true` 只取回收站里的（恢复 / 永久删除）。
 * 策略不存在与无权访问对外同为 404。
 */
export async function loadPolicyForAction(
  policyId: string,
  actor: PolicyActor,
  action: PolicyAction,
  opts: { deleted?: boolean } = {},
): Promise<LoadedPolicy> {
  const policy = await db.query.policies.findFirst({
    where: and(
      eq(policies.id, policyId),
      opts.deleted ? isNotNull(policies.deletedAt) : isNull(policies.deletedAt),
    ),
  });
  if (!policy) return { ok: false, decision: POLICY_NOT_FOUND as Extract<PolicyAccessDecision, { allowed: false }> };
  const decision = await authorizePolicyAction(actor, policy, action);
  return decision.allowed ? { ok: true, policy, decision } : { ok: false, decision };
}

/** 拒绝判定 → JSON 响应（`{ error, code }` + 403/404）。 */
export function policyAccessDeniedResponse(
  decision: Extract<PolicyAccessDecision, { allowed: false }>,
  init: { headers?: HeadersInit } = {},
): NextResponse {
  return NextResponse.json({ error: decision.error, code: decision.code }, { status: decision.status, headers: init.headers });
}

/**
 * 调用者对哪些团队拥有该动作对应的权限：TeamMember 子查询（绕过查询缓存，离队即刻生效）。
 * 列表类查询用 `inArray(policies.teamId, teamsAllowing(...))` 收窄到可见团队。
 */
export function teamsAllowing(userId: string, action: PolicyAction) {
  return db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(and(
      eq(teamMembers.userId, userId),
      inArray(teamMembers.role, rolesWithPermission(POLICY_ACTION_PERMISSION[action])),
      bypassQueryCache(),
    ));
}

/** 个人策略谓词：teamId 为空或空串（与 policyTenantId 的 `||` 口径一致）。 */
export function isPersonalPolicy(): SQL {
  return sql`coalesce(${policies.teamId}, '') = ''`;
}

/**
 * 调用者可对其执行 `action` 的策略集合（不含删除状态过滤）：
 * 本人的个人策略 + 调用者当前角色允许该动作的团队的策略。
 * 不含公开 / 分享授予，那两类由各入口单独叠加。
 */
export function policiesVisibleTo(userId: string, action: PolicyAction): SQL {
  return or(
    and(eq(policies.userId, userId), isPersonalPolicy()),
    inArray(policies.teamId, teamsAllowing(userId, action)),
  )!;
}

/**
 * 「我的策略」列表谓词：本人创建的策略中，个人策略全部保留，团队策略只保留本人当前仍可查看的
 * （离队 / 被移除后不再出现在本人列表里，#670）。
 */
export function ownPoliciesVisibleTo(userId: string): SQL {
  return and(
    eq(policies.userId, userId),
    or(isPersonalPolicy(), inArray(policies.teamId, teamsAllowing(userId, 'view'))),
  )!;
}

/**
 * 日志、统计、漏斗、证据可见的执行人范围：团队策略的执行属于团队，看全部执行（null，#673）；
 * 个人策略只看所有者本人的执行（公开 / 分享给他人执行的记录属于执行人自己）。
 */
export function executionExecutorScope(policy: PolicyAccessSubject): string | null {
  return policyTeamIdOf(policy) ? null : policy.userId;
}
