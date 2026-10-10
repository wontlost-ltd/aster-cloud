// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

// server-only 由 Next 构建期别名提供，测试中以空模块替代。
vi.mock('server-only', () => ({}));
vi.mock('@/lib/api-signing', () => ({ signInternalCallerHeaders: async () => ({}) }));
vi.mock('@/lib/prisma', () => ({ db: {}, complianceReports: {}, policies: {} }));
vi.mock('@/services/evidence/reviewers', () => ({
  guardApprovalReviewers: () => [],
  loadProofReviewers: async () => new Map(),
  loadVersionApprovalReviewers: async () => new Map(),
}));

import { enrichEntries, type EnrichDeps } from '@/lib/evidence';
import type { EvidenceRow } from '@/services/evidence/bundle';
import type { EvidenceWhatIf } from '@/services/evidence/types';

const row = (id: string): EvidenceRow =>
  ({
    id,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    policyTenantId: 't1',
    policyOwnerId: 'owner-1',
    policyVersionRowId: null,
    evidenceCorrelationId: null,
    guardDecisionId: null,
  }) as unknown as EvidenceRow;

const whatIf = { marker: 'stub' } as unknown as EvidenceWhatIf;

function deps(replay: { items?: Map<string, EvidenceWhatIf>; unavailable?: Set<string> }): EnrichDeps {
  const empty = async () => ({ receipts: new Map(), unavailable: new Set<string>(), approvals: new Map() });
  return {
    fetchReceipts: empty,
    fetchDecisionReceipts: empty,
    fetchReplayItems: async () => ({ items: replay.items ?? new Map(), unavailable: replay.unavailable ?? new Set() }),
  } as unknown as EnrichDeps;
}

describe('enrichEntries What-If 接线', () => {
  it('命中的行挂上 whatIf，未命中为 null，不可用计 0', async () => {
    const { entries, whatIfUnavailable } = await enrichEntries(
      [row('exec-1'), row('exec-2')],
      deps({ items: new Map([['exec-1', whatIf]]) }),
    );
    expect(entries[0].whatIf).toEqual(whatIf);
    expect(entries[1].whatIf).toBeNull();
    expect(whatIfUnavailable).toBe(0);
  });

  it('全部不可用：两条 null，whatIfUnavailable = 2', async () => {
    const { entries, whatIfUnavailable } = await enrichEntries(
      [row('exec-1'), row('exec-2')],
      deps({ unavailable: new Set(['exec-1', 'exec-2']) }),
    );
    expect(entries.map((e) => e.whatIf)).toEqual([null, null]);
    expect(whatIfUnavailable).toBe(2);
  });

  it('What-If 按所有者 userId 查询，收据按团队租户查询', async () => {
    const replayTenants: string[] = [];
    const receiptTenants: string[] = [];
    const receipt = async (tenant: string) => {
      receiptTenants.push(tenant);
      return { receipts: new Map(), missing: new Set<string>(), unavailable: new Set<string>(), approvals: new Map() };
    };
    const r = { ...row('exec-1'), policyTenantId: 'team-1', policyOwnerId: 'user-1',
      evidenceCorrelationId: 'c-1', guardDecisionId: 'gd-1' } as EvidenceRow;
    await enrichEntries([r], {
      fetchReceipts: receipt,
      fetchDecisionReceipts: receipt,
      fetchReplayItems: async (tenant: string) => {
        replayTenants.push(tenant);
        return { items: new Map(), unavailable: new Set<string>() };
      },
    } as unknown as EnrichDeps);
    expect(replayTenants).toEqual(['user-1']);
    expect(receiptTenants).toEqual(['team-1', 'team-1']);
  });
});
