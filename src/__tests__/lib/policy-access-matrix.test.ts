// 策略授权矩阵（#669 #670 #671）：资源 × 动作 × 团队角色逐格断言。
// 团队策略只看调用者当前角色，创建者身份不放行任何动作；个人策略只认所有者；团队 key 只能访问本团队策略。

import { describe, expect, it } from 'vitest';
import {
  decidePolicyAccess,
  policyCapabilities,
  POLICY_ACTIONS,
  type PolicyAction,
} from '@/lib/policy-access-matrix';
import { rolesWithPermission, TeamPermission, type TeamRole } from '@/lib/team-permission-matrix';

const TEAM = 'team-1';
const CREATOR = 'u-creator';
const ACTOR = 'u-actor';

const teamPolicy = { userId: CREATOR, teamId: TEAM };
const personalPolicy = { userId: CREATOR, teamId: null };

type Cell = 'allow' | 403 | 404;

// 团队策略：行 = 角色，列 = 动作；调用者不是创建者。
const TEAM_MATRIX: Record<TeamRole, Record<PolicyAction, Cell>> = {
  owner: { view: 'allow', execute: 'allow', update: 'allow', share: 'allow', delete: 'allow', approve: 'allow', whatif: 403 },
  admin: { view: 'allow', execute: 'allow', update: 'allow', share: 'allow', delete: 'allow', approve: 'allow', whatif: 403 },
  member: { view: 'allow', execute: 'allow', update: 'allow', share: 'allow', delete: 403, approve: 403, whatif: 403 },
  viewer: { view: 'allow', execute: 403, update: 403, share: 403, delete: 403, approve: 403, whatif: 403 },
};

function cellOf(d: ReturnType<typeof decidePolicyAccess>): Cell {
  return d.allowed ? 'allow' : d.status;
}

describe('团队策略：按当前角色授权（调用者非创建者）', () => {
  for (const role of Object.keys(TEAM_MATRIX) as TeamRole[]) {
    for (const action of POLICY_ACTIONS) {
      it(`${role} × ${action} → ${TEAM_MATRIX[role][action]}`, () => {
        const d = decidePolicyAccess({ action, actorId: ACTOR, policy: teamPolicy, teamRole: role });
        expect(cellOf(d)).toBe(TEAM_MATRIX[role][action]);
      });
    }
  }

  it('非团队成员（团队外用户）对所有动作 404', () => {
    for (const action of POLICY_ACTIONS) {
      expect(decidePolicyAccess({ action, actorId: ACTOR, policy: teamPolicy, teamRole: null })).toMatchObject({
        allowed: false,
        status: 404,
        code: 'policy_not_found',
      });
    }
  });

  it('角色不够返回 403 insufficient_team_role（成员知道策略存在，不伪装成 404）', () => {
    expect(decidePolicyAccess({ action: 'execute', actorId: ACTOR, policy: teamPolicy, teamRole: 'viewer' })).toMatchObject({
      status: 403,
      code: 'insufficient_team_role',
    });
  });
});

describe('团队策略：创建者身份不放行（#670）', () => {
  it('已离队 / 被移除的创建者（无成员行）对所有动作 404', () => {
    for (const action of POLICY_ACTIONS) {
      expect(cellOf(decidePolicyAccess({ action, actorId: CREATOR, policy: teamPolicy, teamRole: null }))).toBe(404);
    }
  });

  it('创建者被降为 viewer 后只剩查看', () => {
    const caps = policyCapabilities({ actorId: CREATOR, policy: teamPolicy, teamRole: 'viewer' });
    expect(caps).toEqual({
      view: true, execute: false, update: false, share: false, delete: false, approve: false, whatif: false,
    });
  });

  it('member 创建者不能删除自己创建的团队策略（member 无 policy.delete）', () => {
    expect(cellOf(decidePolicyAccess({ action: 'delete', actorId: CREATOR, policy: teamPolicy, teamRole: 'member' }))).toBe(403);
  });

  it('What-If 只给仍有执行权限的创建者（ADR 0034 §4.3 属主限定）', () => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      expect(decidePolicyAccess({ action: 'whatif', actorId: CREATOR, policy: teamPolicy, teamRole: role }).allowed).toBe(true);
    }
    expect(cellOf(decidePolicyAccess({ action: 'whatif', actorId: CREATOR, policy: teamPolicy, teamRole: 'viewer' }))).toBe(403);
  });

  it('非创建者发起 What-If 返回 whatif_owner_only，界面据此给出属主限定提示', () => {
    expect(decidePolicyAccess({ action: 'whatif', actorId: ACTOR, policy: teamPolicy, teamRole: 'owner' })).toMatchObject({
      status: 403,
      code: 'whatif_owner_only',
    });
  });
});

describe('个人策略：只认所有者', () => {
  it('所有者可做全部动作（含自审批与 What-If）', () => {
    for (const action of POLICY_ACTIONS) {
      expect(decidePolicyAccess({ action, actorId: CREATOR, policy: personalPolicy, teamRole: null }).allowed).toBe(true);
    }
  });

  it('他人对所有动作 404', () => {
    for (const action of POLICY_ACTIONS) {
      expect(cellOf(decidePolicyAccess({ action, actorId: ACTOR, policy: personalPolicy, teamRole: null }))).toBe(404);
    }
  });

  it('teamId 为空串视同个人策略（与 policyTenantId 的 || 口径一致）', () => {
    const d = decidePolicyAccess({ action: 'update', actorId: CREATOR, policy: { userId: CREATOR, teamId: '' }, teamRole: null });
    expect(d).toMatchObject({ allowed: true, via: 'owner' });
  });
});

describe('团队作用域 API key（#671）', () => {
  it('团队 key 访问创建者的个人策略 → 404', () => {
    for (const action of POLICY_ACTIONS) {
      expect(cellOf(decidePolicyAccess({ action, actorId: CREATOR, policy: personalPolicy, teamRole: null, keyTeamId: TEAM }))).toBe(404);
    }
  });

  it('团队 key 访问其他团队的策略 → 404（即便持有者也是那个团队的成员）', () => {
    const other = { userId: CREATOR, teamId: 'team-2' };
    expect(cellOf(decidePolicyAccess({ action: 'execute', actorId: ACTOR, policy: other, teamRole: 'owner', keyTeamId: TEAM }))).toBe(404);
  });

  it('团队 key 访问本团队策略按持有者当前角色判定', () => {
    expect(decidePolicyAccess({ action: 'execute', actorId: ACTOR, policy: teamPolicy, teamRole: 'member', keyTeamId: TEAM }).allowed).toBe(true);
    expect(cellOf(decidePolicyAccess({ action: 'execute', actorId: ACTOR, policy: teamPolicy, teamRole: 'viewer', keyTeamId: TEAM }))).toBe(403);
  });

  it('个人 key（keyTeamId 为空）与会话同口径', () => {
    expect(decidePolicyAccess({ action: 'execute', actorId: CREATOR, policy: personalPolicy, teamRole: null, keyTeamId: null }).allowed).toBe(true);
  });
});

describe('角色权限集合', () => {
  it('审批权限只给 owner / admin', () => {
    expect(rolesWithPermission(TeamPermission.POLICY_APPROVE)).toEqual(['admin', 'owner']);
  });

  it('查看权限覆盖全部四个角色', () => {
    expect(rolesWithPermission(TeamPermission.POLICY_VIEW)).toEqual(['viewer', 'member', 'admin', 'owner']);
  });
});
