/**
 * 路由单测用的 @/lib/policy-access 替身：判定走真实的授权矩阵（policy-access-matrix），
 * 只把「取策略行」与「查当前团队角色」两处数据库访问换成可配置的状态。
 *
 * 用法：
 *   vi.mock('@/lib/policy-access', async () =>
 *     (await import('@/__tests__/helpers/policy-access-mock')).policyAccessModule());
 *   import { policyAccessState } from '@/__tests__/helpers/policy-access-mock';
 *   policyAccessState.policy = { id: 'p1', userId: 'u1', teamId: null, ... };
 *   policyAccessState.teamRole = 'member';
 */
import { vi } from 'vitest';
import { NextResponse } from 'next/server';
import {
  decidePolicyAccess,
  policyCapabilities,
  POLICY_NOT_FOUND,
  type PolicyAccessDecision,
  type PolicyAccessSubject,
  type PolicyAction,
} from '@/lib/policy-access-matrix';
import type { TeamRole } from '@/lib/team-permission-matrix';

type Row = PolicyAccessSubject & { id: string; deletedAt?: Date | null; [key: string]: unknown };
type Actor = { userId: string; keyTeamId?: string | null };

export const policyAccessState: {
  policy: Row | null;
  teamRole: TeamRole | null;
  /** 可选：按 id 取策略行（沿用测试里既有的 findFirst 替身）；设置后优先于 policy */
  loader: ((policyId: string) => Promise<Row | null | undefined>) | null;
} = {
  policy: null,
  teamRole: null,
  loader: null,
};

export function resetPolicyAccessState(): void {
  policyAccessState.policy = null;
  policyAccessState.teamRole = null;
  policyAccessState.loader = null;
}

function decide(actor: Actor, policy: PolicyAccessSubject, action: PolicyAction): PolicyAccessDecision {
  return decidePolicyAccess({
    action,
    actorId: actor.userId,
    policy,
    teamRole: policy.teamId ? policyAccessState.teamRole : null,
    keyTeamId: actor.keyTeamId,
  });
}

export function policyAccessModule() {
  return {
    authorizePolicyAction: vi.fn(async (actor: Actor, policy: PolicyAccessSubject, action: PolicyAction) =>
      decide(actor, policy, action)),
    loadPolicyCapabilities: vi.fn(async (actor: Actor, policy: PolicyAccessSubject) =>
      policyCapabilities({ actorId: actor.userId, policy, teamRole: policy.teamId ? policyAccessState.teamRole : null })),
    loadPolicyForAction: vi.fn(async (policyId: string, actor: Actor, action: PolicyAction, opts: { deleted?: boolean } = {}) => {
      const policy = policyAccessState.loader ? (await policyAccessState.loader(policyId)) ?? null : policyAccessState.policy;
      const deleted = Boolean(policy?.deletedAt);
      if (!policy || policy.id !== policyId || deleted !== Boolean(opts.deleted)) {
        return { ok: false, decision: POLICY_NOT_FOUND };
      }
      const decision = decide(actor, policy, action);
      return decision.allowed ? { ok: true, policy, decision } : { ok: false, decision };
    }),
    policyAccessDeniedResponse: (decision: Extract<PolicyAccessDecision, { allowed: false }>, init: { headers?: HeadersInit } = {}) =>
      NextResponse.json({ error: decision.error, code: decision.code }, { status: decision.status, headers: init.headers }),
    executionExecutorScope: (policy: PolicyAccessSubject) => (policy.teamId ? null : policy.userId),
    teamsAllowing: vi.fn(() => ({ __teamsAllowing: true })),
    isPersonalPolicy: vi.fn(() => ({ __personal: true })),
    policiesVisibleTo: vi.fn(() => ({ __visible: true })),
    ownPoliciesVisibleTo: vi.fn((userId: string) => ({ __ownVisible: userId })),
    decidePolicyAccess,
  };
}
