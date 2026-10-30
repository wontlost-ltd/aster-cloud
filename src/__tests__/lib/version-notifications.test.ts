import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 策略版本审批通知（#678）：
 *   - 提交审批：通知团队里能审批的人（owner / admin），不含提交者；个人策略不通知（所有者自审）。
 *   - 批准 / 驳回：通知版本作者（驳回带理由）；审批人就是作者（个人策略自审）时不通知。
 *   - 通知失败只记日志，不抛出。
 */
const h = vi.hoisted(() => ({
  policyFindFirst: vi.fn(),
  versionFindFirst: vi.fn(),
  reviewerIds: vi.fn(),
  createNotification: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  db: { query: { policies: { findFirst: h.policyFindFirst }, policyVersions: { findFirst: h.versionFindFirst } } },
  policies: { id: 'p.id' },
  policyVersions: { policyId: 'v.policyId', version: 'v.version' },
}));
vi.mock('@/services/policy/version-manager', () => ({ loadTeamReviewerIds: h.reviewerIds }));
vi.mock('@/lib/notifications', () => ({ createNotification: h.createNotification }));

import { notifyVersionDecided, notifyVersionSubmitted } from '@/lib/version-notifications';

describe('notifyVersionSubmitted', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.createNotification.mockResolvedValue('n1');
  });

  it('团队策略：通知除提交者外的 owner / admin', async () => {
    h.policyFindFirst.mockResolvedValue({ name: 'Loan', teamId: 't1' });
    h.reviewerIds.mockResolvedValue(['owner', 'admin', 'submitter']);

    await notifyVersionSubmitted({ policyId: 'p1', version: 2, submitterId: 'submitter' });

    expect(h.reviewerIds).toHaveBeenCalledWith('t1');
    const recipients = h.createNotification.mock.calls.map(([a]) => a.userId);
    expect(recipients.sort()).toEqual(['admin', 'owner']);
    expect(h.createNotification).toHaveBeenCalledWith({
      userId: 'owner',
      kind: 'policy.version_submitted',
      data: { policyId: 'p1', policyName: 'Loan', version: 2, teamId: 't1' },
    });
  });

  it('个人策略不通知', async () => {
    h.policyFindFirst.mockResolvedValue({ name: 'Mine', teamId: null });
    await notifyVersionSubmitted({ policyId: 'p1', version: 1, submitterId: 'u1' });
    expect(h.createNotification).not.toHaveBeenCalled();
  });

  it('查询失败不抛出', async () => {
    h.policyFindFirst.mockRejectedValue(new Error('db down'));
    await expect(notifyVersionSubmitted({ policyId: 'p1', version: 1, submitterId: 'u1' })).resolves.toBeUndefined();
  });
});

describe('notifyVersionDecided', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.createNotification.mockResolvedValue('n1');
    h.policyFindFirst.mockResolvedValue({ name: 'Loan', teamId: 't1' });
  });

  it('驳回：通知作者并带驳回理由', async () => {
    h.versionFindFirst.mockResolvedValue({ createdBy: 'author' });
    await notifyVersionDecided({ policyId: 'p1', version: 2, reviewerId: 'owner', outcome: 'REJECTED', comment: ' too risky ' });
    expect(h.createNotification).toHaveBeenCalledWith({
      userId: 'author',
      kind: 'policy.version_decided',
      data: { policyId: 'p1', policyName: 'Loan', version: 2, outcome: 'REJECTED', comment: 'too risky' },
    });
  });

  it('批准：通知作者，无理由时不带 comment', async () => {
    h.versionFindFirst.mockResolvedValue({ createdBy: 'author' });
    await notifyVersionDecided({ policyId: 'p1', version: 2, reviewerId: 'owner', outcome: 'APPROVED' });
    expect(h.createNotification.mock.calls[0][0].data).toEqual({
      policyId: 'p1', policyName: 'Loan', version: 2, outcome: 'APPROVED',
    });
  });

  it('审批人就是作者（个人策略自审）不通知', async () => {
    h.versionFindFirst.mockResolvedValue({ createdBy: 'owner' });
    await notifyVersionDecided({ policyId: 'p1', version: 1, reviewerId: 'owner', outcome: 'APPROVED' });
    expect(h.createNotification).not.toHaveBeenCalled();
  });
});
