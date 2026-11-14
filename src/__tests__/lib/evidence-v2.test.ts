// @vitest-environment node
// 证据包 v2 拼装单测（ADR 0041 §5）：mock 查询层 + 收据客户端 + 复核者加载，
// 断言每条目的收据状态/引用、复核者来源组合、manifest 计数，以及收据全不可用时导出仍完成。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EvidenceRow } from '@/services/evidence/bundle';
import type { ChainApproval, ReceiptLookup } from '@/services/evidence/receipts-client';
import type { Reviewer } from '@/services/evidence/reviewers';

vi.mock('server-only', () => ({}));

const insertReturning = vi.fn();
const updateSet = vi.fn();

vi.mock('@/lib/prisma', () => ({
  db: {
    query: { policies: { findFirst: vi.fn() } },
    insert: () => ({ values: () => ({ returning: () => insertReturning() }) }),
    update: () => ({ set: (v: unknown) => ({ where: () => updateSet(v) }) }),
  },
  complianceReports: { id: 'cr.id', userId: 'cr.userId', data: 'cr.data', createdAt: 'cr.createdAt' },
  policies: { id: 'p.id', userId: 'p.userId' },
  policyProofs: {},
  policyApprovals: {},
}));

vi.mock('drizzle-orm', () => ({
  and: (...a: unknown[]) => ({ op: 'and', a }),
  eq: (c: unknown, v: unknown) => ({ op: 'eq', c, v }),
  desc: (c: unknown) => ({ op: 'desc', c }),
  inArray: (c: unknown, v: unknown) => ({ op: 'inArray', c, v }),
  sql: () => ({ op: 'sql' }),
}));

const queryEvidenceExecutions = vi.fn();
vi.mock('@/lib/evidence-export', () => ({
  queryEvidenceExecutions: (...a: unknown[]) => queryEvidenceExecutions(...a),
}));

const fetchReceipts = vi.fn();
const fetchDecisionReceipts = vi.fn();
vi.mock('@/services/evidence/receipts-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/evidence/receipts-client')>()),
  fetchReceipts: (...a: unknown[]) => fetchReceipts(...a),
  fetchDecisionReceipts: (...a: unknown[]) => fetchDecisionReceipts(...a),
}));

const loadProofReviewers = vi.fn();
const loadVersionApprovalReviewers = vi.fn();
vi.mock('@/services/evidence/reviewers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/evidence/reviewers')>()),
  loadProofReviewers: (...a: unknown[]) => loadProofReviewers(...a),
  loadVersionApprovalReviewers: (...a: unknown[]) => loadVersionApprovalReviewers(...a),
}));

import { createEvidenceExport } from '@/lib/evidence';

function row(over: Partial<EvidenceRow>): EvidenceRow {
  return {
    id: 'e', policyId: 'pol', policyVersion: 1, policyVersionRowId: null, decision: 'approved',
    canonicalInputHash: 'in', canonicalOutputHash: 'out', traceHash: 'tr', canonicalizationVersion: 'v1',
    sourceToolchainId: null, runtimeToolchainId: null, replayabilityStatus: null, replayabilityReasons: null,
    reasonCodes: null, source: 'api', durationMs: 1, createdAt: new Date('2026-10-01T00:00:00Z'),
    outcome: 'ALLOW', ruleId: null, controls: null, agent: null, evidenceCorrelationId: null,
    policyTenantId: 'team-1', policyOwnerId: 'user-1', guardDecisionId: null, profile: null,
    ...over,
  };
}

function lookup(): ReceiptLookup {
  return {
    receipts: new Map(), approvals: new Map(), consumes: new Map(), results: new Map(),
    missing: new Set(), unavailable: new Set(),
  };
}

const ROWS: EvidenceRow[] = [
  // 正常：有关联 id，收据命中；版本 pv-1 有 VERIFIED proof。
  row({ id: 'e1', evidenceCorrelationId: 'c-1', policyVersionRowId: 'pv-1',
    agent: { provider: 'anthropic', model: 'claude', source: 'declared' },
    createdAt: new Date('2026-10-01T00:00:00Z') }),
  // legacy：无关联 id。
  row({ id: 'e2', evidenceCorrelationId: null, decision: null, outcome: null,
    createdAt: new Date('2026-10-02T00:00:00Z') }),
  // 带 guardDecisionId，收据不可用；另一租户。
  row({ id: 'e3', evidenceCorrelationId: 'c-3', guardDecisionId: 'gd-3', decision: 'require_approval',
    policyTenantId: 'user-9', createdAt: new Date('2026-10-03T00:00:00Z') }),
];

const PROOF: Reviewer = {
  userId: 'u-p', role: 'domain_expert', source: 'policy-proof', outcome: 'VERIFIED',
  decidedAt: '2026-09-30T00:00:00.000Z', ref: 'proof-1', roleVerified: true,
  inputSnapshotHash: null, inputSnapshotMatched: null, inputRevealed: null, inputStatus: null,
};

const NO_SNAPSHOT = { inputSnapshotHash: null, inputSnapshotMatched: null, inputRevealed: null, inputStatus: null };

beforeEach(() => {
  vi.clearAllMocks();
  insertReturning.mockResolvedValue([{ id: 'rep-1' }]);
  updateSet.mockResolvedValue(undefined);
  queryEvidenceExecutions.mockResolvedValue(ROWS);
  fetchReceipts.mockImplementation(async (tenant: string, ids: string[]) => {
    const l = lookup();
    if (tenant === 'team-1' && ids.includes('c-1')) {
      l.receipts.set('c-1', { auditId: 11, currentHash: 'h11', prevHash: 'h10', hashVersion: 2,
        eventType: 'POLICY_EVALUATION', timestamp: '2026-10-01T00:00:00Z', metadata: {}, authoritativeConsumeAuditId: null });
    }
    if (tenant === 'user-9') ids.forEach((id) => l.unavailable.add(id));
    return l;
  });
  fetchDecisionReceipts.mockImplementation(async (_tenant: string, ids: string[]) => {
    const l = lookup();
    for (const id of ids) {
      const approval: ChainApproval = { auditId: 31, decisionId: id, outcome: 'APPROVED', decidedBy: 'u-g',
        requiredRole: 'risk_officer', comment: null, decidedAt: '2026-10-03T01:00:00Z',
        currentHash: 'h31', decisionReceiptHash: null, ...NO_SNAPSHOT };
      l.approvals.set(id, [approval]);
    }
    return l;
  });
  loadProofReviewers.mockResolvedValue(new Map([['pv-1', [PROOF]]]));
  loadVersionApprovalReviewers.mockResolvedValue(new Map());
});

function storedBundle() {
  const set = updateSet.mock.calls.map((c) => c[0]).find((v) => v.status === 'completed');
  return set?.data.bundle;
}

describe('createEvidenceExport v2', () => {
  it('★按租户分组取收据，按 guardDecisionId 取审批，版本 id 批量取复核者', async () => {
    await createEvidenceExport('user-1', { format: 'json' });
    expect(fetchReceipts).toHaveBeenCalledTimes(2);
    expect(fetchReceipts).toHaveBeenCalledWith('team-1', ['c-1'], fetch, expect.any(Function));
    expect(fetchReceipts).toHaveBeenCalledWith('user-9', ['c-3'], fetch, expect.any(Function));
    expect(fetchDecisionReceipts).toHaveBeenCalledTimes(1);
    expect(fetchDecisionReceipts).toHaveBeenCalledWith('user-9', ['gd-3'], fetch, expect.any(Function));
    expect(loadProofReviewers).toHaveBeenCalledWith(['pv-1']);
    expect(loadVersionApprovalReviewers).toHaveBeenCalledWith(['pv-1']);
  });

  it('★所有租户、两类查找共用同一个限流器（全局在途批次有界）', async () => {
    await createEvidenceExport('user-1', { format: 'json' });
    const limiters = [...fetchReceipts.mock.calls, ...fetchDecisionReceipts.mock.calls].map((c) => c[3]);
    expect(limiters).toHaveLength(3);
    expect(new Set(limiters).size).toBe(1);
  });

  it('★线上形状（链首行省略 prevHash）经真实客户端解析 → 导出 completed，收据 prevHash=null', async () => {
    const real = await vi.importActual<typeof import('@/services/evidence/receipts-client')>(
      '@/services/evidence/receipts-client',
    );
    const wire = (async () => new Response(JSON.stringify({
      receipts: [{ auditId: 11, correlationId: 'c-1', currentHash: 'h11', eventType: 'POLICY_EVALUATION',
        hashVersion: 2, metadata: {}, timestamp: '2026-10-01T00:00:00Z' }],
    }), { status: 200 })) as unknown as typeof fetch;
    fetchReceipts.mockImplementation((t: string, ids: string[], _f: typeof fetch, limiter) =>
      real.fetchReceipts(t, ids, wire, limiter));
    queryEvidenceExecutions.mockResolvedValue([ROWS[0]]);

    await createEvidenceExport('user-1', { format: 'json' });
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    const [e1] = storedBundle().entries;
    expect(e1.receipt).toEqual({ auditId: 11, currentHash: 'h11', prevHash: null, hashVersion: 2 });
  });

  it('★三条目的收据状态/引用与复核者来源组合', async () => {
    await createEvidenceExport('user-1', { format: 'json' });
    const [e1, e2, e3] = storedBundle().entries;
    expect(e1.receipt).toEqual({ auditId: 11, currentHash: 'h11', prevHash: 'h10', hashVersion: 2 });
    expect(e1.reviewers).toEqual([PROOF]);
    expect(e2.receipt).toEqual({ status: 'legacy' });
    expect(e2.reviewers).toEqual([]);
    expect(e3.receipt).toEqual({ status: 'unavailable' });
    expect(e3.reviewers).toEqual([{
      userId: 'u-g', role: 'risk_officer', source: 'guard-approval', outcome: 'APPROVED',
      decidedAt: '2026-10-03T01:00:00Z', ref: '31', roleVerified: true, ...NO_SNAPSHOT,
    }]);
    expect(e1).not.toHaveProperty('policyTenantId');
    expect(e1).not.toHaveProperty('policyOwnerId');
    expect(e3).not.toHaveProperty('guardDecisionId');
  });

  it('★manifest 计数', async () => {
    const { manifest } = await createEvidenceExport('user-1', { format: 'json' });
    expect(manifest.schemaVersion).toBe('6');
    expect(manifest.totals.count).toBe(3);
    expect(manifest.legacyEntries).toBe(1);
    expect(manifest.notes.receiptsUnavailable).toBe(1);
    expect(manifest.notes.receiptsMissing).toBe(0);
    expect(manifest.reviewerTally).toEqual({ 'guard-approval': 1, 'policy-proof': 1, 'version-approval': 0 });
    expect(manifest.agentTally).toEqual({ 'anthropic/claude': 1, unknown: 2 });
    expect(manifest.decisionTally).toMatchObject({ approved: 1, require_approval: 1, unknown: 1 });
  });

  it('★收据服务全部不可用 → 导出仍 completed，条目标 unavailable', async () => {
    fetchReceipts.mockImplementation(async (_t: string, ids: string[]) => {
      const l = lookup();
      ids.forEach((id) => l.unavailable.add(id));
      return l;
    });
    fetchDecisionReceipts.mockImplementation(async (_t: string, ids: string[]) => {
      const l = lookup();
      ids.forEach((id) => l.unavailable.add(id));
      return l;
    });
    const { id, manifest } = await createEvidenceExport('user-1', { format: 'json' });
    expect(id).toBe('rep-1');
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    expect(updateSet).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    expect(manifest.notes.receiptsUnavailable).toBe(2);
    expect(manifest.legacyEntries).toBe(1);
    const entries = storedBundle().entries;
    expect(entries[2].reviewers).toEqual([]);
  });

  it('无关联 id / guardDecisionId / 版本 id 时不发起收据请求', async () => {
    queryEvidenceExecutions.mockResolvedValue([row({ id: 'only-legacy' })]);
    const { manifest } = await createEvidenceExport('user-1', { format: 'json' });
    expect(fetchReceipts).not.toHaveBeenCalled();
    expect(fetchDecisionReceipts).not.toHaveBeenCalled();
    expect(loadProofReviewers).toHaveBeenCalledWith([]);
    expect(manifest.legacyEntries).toBe(1);
  });
});

describe('createEvidenceExport v6（ADR 0042 §12 D9）', () => {
  it('★经真实收据客户端解析线上形状：评估来源、guard 逐字段来源、执行收据、复核者快照四键接线到条目与 manifest', async () => {
    const real = await vi.importActual<typeof import('@/services/evidence/receipts-client')>(
      '@/services/evidence/receipts-client',
    );
    const factSources = ['context.applicant.id=hmac.userId', 'context.applicant.income=fixture.creditPilot'];
    const evalWire = (async () => new Response(JSON.stringify({
      receipts: [{ auditId: 11, correlationId: 'c-1', currentHash: 'h11', eventType: 'POLICY_EVALUATION',
        hashVersion: 2, metadata: { inputSource: 'declared' }, timestamp: '2026-10-01T00:00:00Z' }],
    }), { status: 200 })) as unknown as typeof fetch;
    const decisionWire = (async () => new Response(JSON.stringify({
      approvals: [{ auditId: 31, currentHash: 'h31', decidedAt: '2026-10-03T01:00:00Z', decidedBy: 'u-g',
        decisionId: 'gd-1', decisionReceiptHash: 'h20', inputRevealed: true, inputSnapshotHash: 'a'.repeat(64),
        inputSnapshotMatched: true, inputStatus: 'available', outcome: 'APPROVED', requiredRole: 'risk_officer' }],
      consumes: [{ actionHash: 'ah', auditId: 40, attemptId: 'att-1', authoritative: true, currentHash: 'h40',
        decisionId: 'gd-1', executorId: 'mcp@host', outcome: 'consumed', timestamp: '2026-10-03T02:00:00Z' }],
      receipts: [{ auditId: 20, authoritativeConsumeAuditId: 40, currentHash: 'h20', decisionId: 'gd-1',
        eventType: 'ACTION_GUARD_DECISION', hashVersion: 2, timestamp: '2026-10-03T00:00:00Z',
        metadata: { decisionId: 'gd-1', factIssuers: ['aster-cloud#k1'], factSources,
          verifiedFields: ['context.applicant.id', 'context.applicant.income'] } }],
      results: [{ auditId: 41, attemptId: 'att-1', authoritative: true, consumeReceiptHash: 'h40', currentHash: 'h41',
        decisionId: 'gd-1', executorId: 'mcp@host', status: 'executed', timestamp: '2026-10-03T03:00:00Z' }],
      reveals: [{ approvalId: 'ap-1', auditId: 30, currentHash: 'h30', decisionId: 'gd-1', performedBy: 'u-g',
        timestamp: '2026-10-03T00:30:00Z' }],
    }), { status: 200 })) as unknown as typeof fetch;
    fetchReceipts.mockImplementation((t: string, ids: string[], _f: typeof fetch, limiter) =>
      real.fetchReceipts(t, ids, evalWire, limiter));
    fetchDecisionReceipts.mockImplementation((t: string, ids: string[], _f: typeof fetch, limiter) =>
      real.fetchDecisionReceipts(t, ids, decisionWire, limiter));
    queryEvidenceExecutions.mockResolvedValue([
      row({ id: 'e1', evidenceCorrelationId: 'c-1', guardDecisionId: 'gd-1', decision: 'require_approval',
        outcome: 'REQUIRE_APPROVAL' }),
    ]);
    loadProofReviewers.mockResolvedValue(new Map());

    const { manifest } = await createEvidenceExport('user-1', { format: 'json' });
    const [e1] = storedBundle().entries;
    expect(e1.inputSource).toBe('declared');
    expect(e1.guardInputSources).toEqual({
      verified: ['context.applicant.id', 'context.applicant.income'], factIssuers: ['aster-cloud#k1'], factSources,
    });
    expect(e1.execution).toEqual({
      consumed: true, executorId: 'mcp@host', attemptId: 'att-1', resultStatus: 'executed', consumeAuditId: 40,
    });
    expect(e1.reviewers).toEqual([expect.objectContaining({
      source: 'guard-approval', inputSnapshotHash: 'a'.repeat(64), inputSnapshotMatched: true, inputRevealed: true,
      inputStatus: 'available',
    })]);
    // 解除记录不进包（ADR 0042 §12 D9）
    expect(JSON.stringify(storedBundle())).not.toContain('performedBy');
    expect(manifest).toMatchObject({
      schemaVersion: '6',
      inputSourceTally: { declared: 1, mixed: 0, legacy: 0 },
      verifiedInputsUsed: 1,
      executionTally: { consumed: 1, unconsumedAllow: 0, executed: 1, failed: 0, aborted: 0 },
      inputSnapshotTally: { matched: 1, unmatched: 0, unavailable: 0 },
    });
  });

  it('旧 api（无快照键、无 consumes/results/authoritativeConsumeAuditId）→ 字段为 null / 未消耗，导出不报错', async () => {
    const real = await vi.importActual<typeof import('@/services/evidence/receipts-client')>(
      '@/services/evidence/receipts-client',
    );
    const oldWire = (async () => new Response(JSON.stringify({
      approvals: [{ auditId: 31, currentHash: 'h31', decidedAt: '2026-10-03T01:00:00Z', decidedBy: 'u-g',
        decisionId: 'gd-1', outcome: 'APPROVED', requiredRole: 'risk_officer' }],
      receipts: [{ auditId: 20, currentHash: 'h20', decisionId: 'gd-1', eventType: 'ACTION_GUARD_DECISION',
        hashVersion: 2, timestamp: '2026-10-03T00:00:00Z', metadata: { decisionId: 'gd-1' } }],
    }), { status: 200 })) as unknown as typeof fetch;
    fetchDecisionReceipts.mockImplementation((t: string, ids: string[], _f: typeof fetch, limiter) =>
      real.fetchDecisionReceipts(t, ids, oldWire, limiter));
    queryEvidenceExecutions.mockResolvedValue([row({ id: 'e1', guardDecisionId: 'gd-1', outcome: 'REQUIRE_APPROVAL' })]);
    loadProofReviewers.mockResolvedValue(new Map());

    const { manifest } = await createEvidenceExport('user-1', { format: 'json' });
    const [e1] = storedBundle().entries;
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    expect(e1.inputSource).toBe('legacy');
    expect(e1.guardInputSources).toEqual({ verified: [], factIssuers: [], factSources: [] });
    expect(e1.execution).toEqual({ consumed: false });
    expect(e1.reviewers[0]).toMatchObject(NO_SNAPSHOT);
    expect(manifest.inputSnapshotTally).toEqual({ matched: 0, unmatched: 0, unavailable: 1 });
    expect(manifest.executionTally.unconsumedAllow).toBe(1);
  });
});
