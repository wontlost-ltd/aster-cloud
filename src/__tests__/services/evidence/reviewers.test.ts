// 复核者拼装单测（ADR 0041 §5.2）：proof 取每 (policyId,nodeId) 最新；版本审批逐条；guard 审批 roleVerified=true。

import { describe, it, expect, vi, beforeEach } from 'vitest';

const proofsFindMany = vi.fn();
const approvalsFindMany = vi.fn();

vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      policyProofs: { findMany: (...a: unknown[]) => proofsFindMany(...a) },
      policyApprovals: { findMany: (...a: unknown[]) => approvalsFindMany(...a) },
    },
  },
  policyProofs: { policyVersionId: 'policyProofs.policyVersionId' },
  policyApprovals: { versionId: 'policyApprovals.versionId' },
}));

vi.mock('drizzle-orm', () => ({
  inArray: (col: unknown, vals: unknown[]) => ({ op: 'inArray', col, vals }),
}));

import {
  loadProofReviewers,
  loadVersionApprovalReviewers,
  guardApprovalReviewers,
} from '@/services/evidence/reviewers';
import type { ChainApproval } from '@/services/evidence/receipts-client';

beforeEach(() => {
  proofsFindMany.mockReset();
  approvalsFindMany.mockReset();
});

describe('loadProofReviewers', () => {
  it('同 (policyId,nodeId) 两条 proof 只取最新', async () => {
    proofsFindMany.mockResolvedValue([
      { id: 'p-new', policyId: 'pol', policyVersionId: 'pv-1', nodeId: 'n1', verdict: 'VERIFIED',
        subjectKind: 'domain_expert', subjectUserId: 'u-2', createdAt: new Date('2026-10-02T00:00:00Z') },
      { id: 'p-old', policyId: 'pol', policyVersionId: 'pv-1', nodeId: 'n1', verdict: 'REJECTED',
        subjectKind: 'engineer', subjectUserId: 'u-1', createdAt: new Date('2026-10-01T00:00:00Z') },
    ]);

    const out = await loadProofReviewers(['pv-1']);
    expect(proofsFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { op: 'inArray', col: 'policyProofs.policyVersionId', vals: ['pv-1'] },
    }));
    expect(out.get('pv-1')).toEqual([{
      userId: 'u-2', role: 'domain_expert', source: 'policy-proof', outcome: 'VERIFIED',
      decidedAt: '2026-10-02T00:00:00.000Z', ref: 'p-new', roleVerified: true,
    }]);
  });

  it('★同 (policyId,nodeId) 同一时间戳 ⇒ 按 id 决胜，输入顺序反转结果不变', async () => {
    const at = new Date('2026-10-02T00:00:00Z');
    const rows = [
      { id: 'p-a', policyId: 'pol', policyVersionId: 'pv-1', nodeId: 'n1', verdict: 'REJECTED',
        subjectKind: 'engineer', subjectUserId: 'u-1', createdAt: at },
      { id: 'p-b', policyId: 'pol', policyVersionId: 'pv-1', nodeId: 'n1', verdict: 'VERIFIED',
        subjectKind: 'domain_expert', subjectUserId: 'u-2', createdAt: new Date(at.getTime()) },
    ];
    proofsFindMany.mockResolvedValueOnce(rows);
    const first = await loadProofReviewers(['pv-1']);
    proofsFindMany.mockResolvedValueOnce([...rows].reverse());
    const second = await loadProofReviewers(['pv-1']);

    expect(first.get('pv-1')?.map((r) => r.ref)).toEqual(['p-b']);
    expect(second.get('pv-1')).toEqual(first.get('pv-1'));
  });

  it('不同节点各留一条，按版本分组', async () => {
    proofsFindMany.mockResolvedValue([
      { id: 'a', policyId: 'pol', policyVersionId: 'pv-1', nodeId: 'n1', verdict: 'VERIFIED',
        subjectKind: 'engineer', subjectUserId: 'u-1', createdAt: new Date('2026-10-01T00:00:00Z') },
      { id: 'b', policyId: 'pol', policyVersionId: 'pv-1', nodeId: 'n2', verdict: 'VERIFIED',
        subjectKind: 'engineer', subjectUserId: 'u-1', createdAt: new Date('2026-10-01T00:00:00Z') },
      { id: 'c', policyId: 'pol', policyVersionId: 'pv-2', nodeId: 'n1', verdict: 'REJECTED',
        subjectKind: 'engineer', subjectUserId: 'u-3', createdAt: new Date('2026-10-03T00:00:00Z') },
    ]);
    const out = await loadProofReviewers(['pv-1', 'pv-2']);
    expect(out.get('pv-1')?.map((r) => r.ref).sort()).toEqual(['a', 'b']);
    expect(out.get('pv-2')?.map((r) => r.ref)).toEqual(['c']);
  });

  it('空输入不查库', async () => {
    const out = await loadProofReviewers([]);
    expect(out.size).toBe(0);
    expect(proofsFindMany).not.toHaveBeenCalled();
  });
});

describe('loadVersionApprovalReviewers', () => {
  it('两条审批 ⇒ 两个 reviewer', async () => {
    approvalsFindMany.mockResolvedValue([
      { id: 'a1', versionId: 'pv-1', approverId: 'u-1', decision: 'APPROVED', createdAt: new Date('2026-10-01T00:00:00Z') },
      { id: 'a2', versionId: 'pv-1', approverId: 'u-2', decision: 'REJECTED', createdAt: new Date('2026-10-02T00:00:00Z') },
    ]);
    const out = await loadVersionApprovalReviewers(['pv-1']);
    expect(approvalsFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { op: 'inArray', col: 'policyApprovals.versionId', vals: ['pv-1'] },
    }));
    expect(out.get('pv-1')).toEqual([
      { userId: 'u-1', role: 'approver', source: 'version-approval', outcome: 'APPROVED',
        decidedAt: '2026-10-01T00:00:00.000Z', ref: 'a1', roleVerified: true },
      { userId: 'u-2', role: 'approver', source: 'version-approval', outcome: 'REJECTED',
        decidedAt: '2026-10-02T00:00:00.000Z', ref: 'a2', roleVerified: true },
    ]);
  });

  it('空输入不查库', async () => {
    expect((await loadVersionApprovalReviewers([])).size).toBe(0);
    expect(approvalsFindMany).not.toHaveBeenCalled();
  });
});

describe('guardApprovalReviewers', () => {
  it('映射字段；requiredRole 缺省为 unknown；roleVerified=true', () => {
    const approvals: ChainApproval[] = [
      { auditId: 8, decisionId: 'd-1', outcome: 'APPROVED', decidedBy: 'u-1', requiredRole: 'risk', comment: null,
        decidedAt: '2026-10-01T01:00:00Z', currentHash: 'h1', decisionReceiptHash: 'hd' },
      { auditId: 9, decisionId: 'd-1', outcome: 'REJECTED', decidedBy: 'u-2', requiredRole: null, comment: 'no',
        decidedAt: '2026-10-01T02:00:00Z', currentHash: 'h2', decisionReceiptHash: null },
    ];
    expect(guardApprovalReviewers(approvals)).toEqual([
      { userId: 'u-1', role: 'risk', source: 'guard-approval', outcome: 'APPROVED',
        decidedAt: '2026-10-01T01:00:00Z', ref: '8', roleVerified: true },
      { userId: 'u-2', role: 'unknown', source: 'guard-approval', outcome: 'REJECTED',
        decidedAt: '2026-10-01T02:00:00Z', ref: '9', roleVerified: true },
    ]);
  });
});
