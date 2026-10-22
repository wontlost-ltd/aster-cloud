// 策略版本审批规则（approveVersion、版本页、详情页版本面板与审批收件箱共用的单一判定）。
import { describe, it, expect } from 'vitest';
import { canReviewPolicyVersions, decideVersionApproval } from '@/services/policy/version-approval-rules';

const team = { policyOwnerId: 'author', policyTeamId: 'team1' };
const personal = { policyOwnerId: 'owner', policyTeamId: null };

describe('decideVersionApproval — 团队策略', () => {
  it('团队 admin（非作者）可审批', () => {
    expect(decideVersionApproval({ ...team, reviewerId: 'admin1', reviewerTeamRole: 'admin', versionAuthorId: 'author' }))
      .toEqual({ allowed: true, selfApproved: false });
  });

  it('团队 owner（非作者）可审批', () => {
    expect(decideVersionApproval({ ...team, reviewerId: 'boss', reviewerTeamRole: 'owner', versionAuthorId: 'author' }).allowed)
      .toBe(true);
  });

  it('作者即使是团队 admin 也不能审批自己的版本（四眼原则）', () => {
    expect(decideVersionApproval({ ...team, reviewerId: 'author', reviewerTeamRole: 'admin', versionAuthorId: 'author' }))
      .toEqual({ allowed: false, reason: 'segregation_of_duties' });
  });

  it('普通成员、只读成员与非成员无审阅权（即使是策略所有者）', () => {
    for (const role of ['member', 'viewer', null] as const) {
      expect(decideVersionApproval({ ...team, reviewerId: 'm1', reviewerTeamRole: role, versionAuthorId: 'author' }))
        .toEqual({ allowed: false, reason: 'not_authorized' });
    }
    expect(canReviewPolicyVersions({ ...team, reviewerId: 'author', reviewerTeamRole: 'member' })).toBe(false);
  });
});

describe('decideVersionApproval — 个人策略', () => {
  it('所有者可审批自己提交的版本，并标记为自审', () => {
    expect(decideVersionApproval({ ...personal, reviewerId: 'owner', reviewerTeamRole: null, versionAuthorId: 'owner' }))
      .toEqual({ allowed: true, selfApproved: true });
  });

  it('所有者审批他人创建的版本（历史数据）不算自审', () => {
    expect(decideVersionApproval({ ...personal, reviewerId: 'owner', reviewerTeamRole: null, versionAuthorId: 'legacy' }))
      .toEqual({ allowed: true, selfApproved: false });
  });

  it('非所有者无审阅权', () => {
    expect(decideVersionApproval({ ...personal, reviewerId: 'other', reviewerTeamRole: null, versionAuthorId: 'owner' }))
      .toEqual({ allowed: false, reason: 'not_authorized' });
  });
});
