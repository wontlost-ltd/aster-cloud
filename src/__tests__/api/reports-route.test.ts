// 证据导出接口（POST 生成/预览 + 门控）单测。mock 掉 DB/evidence 层，只验路由逻辑：
// 付费门控、dryRun 预览、日期校验、413（超限）、格式默认。

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/usage', () => ({
  hasFeatureAccess: vi.fn(),
  recordUsage: vi.fn().mockResolvedValue(undefined),
  EVIDENCE_EXPORT_METRIC: 'compliance_report',
}));
vi.mock('@/lib/evidence', () => ({
  createEvidenceExport: vi.fn(),
  listEvidenceExports: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/evidence-export', async () => {
  const actual = await vi.importActual<typeof import('@/lib/evidence-export')>('@/lib/evidence-export');
  return {
    getEvidencePreview: vi.fn(),
    EvidenceTooLargeError: actual.EvidenceTooLargeError,
  };
});

import { POST, GET } from '@/app/api/reports/route';
import { getSession } from '@/lib/auth';
import { hasFeatureAccess, recordUsage } from '@/lib/usage';
import { createEvidenceExport } from '@/lib/evidence';
import { getEvidencePreview, EvidenceTooLargeError } from '@/lib/evidence-export';

function post(body: unknown) {
  return new Request('http://localhost/api/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue({ user: { id: 'user-1' } } as never);
  vi.mocked(hasFeatureAccess).mockResolvedValue(true);
});

describe('GET /api/reports', () => {
  it('未登录 → 401', async () => {
    vi.mocked(getSession).mockResolvedValue(null as never);
    expect((await GET()).status).toBe(401);
  });
});

describe('POST /api/reports — 门控', () => {
  it('未登录 → 401', async () => {
    vi.mocked(getSession).mockResolvedValue(null as never);
    expect((await POST(post({}))).status).toBe(401);
  });

  it('★无付费权限 → 403 upgrade', async () => {
    vi.mocked(hasFeatureAccess).mockResolvedValue(false);
    const r = await POST(post({ format: 'json' }));
    expect(r.status).toBe(403);
    expect((await r.json()).upgrade).toBe(true);
    expect(createEvidenceExport).not.toHaveBeenCalled();
  });

  it('门控用 evidenceExport 能力键', async () => {
    await POST(post({ dryRun: true }));
    expect(hasFeatureAccess).toHaveBeenCalledWith('user-1', 'evidenceExport');
  });
});

describe('POST /api/reports — 校验', () => {
  it('startDate 非法 → 400', async () => {
    const r = await POST(post({ startDate: 'not-a-date', format: 'json' }));
    expect(r.status).toBe(400);
  });

  it('start > end → 400', async () => {
    const r = await POST(post({
      startDate: '2026-07-31T00:00:00Z',
      endDate: '2026-07-01T00:00:00Z',
      format: 'json',
    }));
    expect(r.status).toBe(400);
  });
});

describe('POST /api/reports — dryRun 预览', () => {
  it('dryRun → 返回 preview，不生成导出', async () => {
    vi.mocked(getEvidencePreview).mockResolvedValue({
      count: 5, decisionTally: { approved: 5, denied: 0, indeterminate: 0, error: 0, require_approval: 0, escalate: 0, unknown: 0 },
      coverage: { verifiable: 5, legacy: 0 }, exceedsLimit: false, limit: 50000,
    });
    const r = await POST(post({ dryRun: true }));
    expect(r.status).toBe(200);
    expect((await r.json()).count).toBe(5);
    expect(createEvidenceExport).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });
});

describe('POST /api/reports — 生成', () => {
  it('成功 → 201 + id + manifest + 计量（用 compliance_report 持久值）', async () => {
    vi.mocked(createEvidenceExport).mockResolvedValue({ id: 'exp-1', manifest: { totals: { count: 3 } } as never });
    const r = await POST(post({ policyId: 'p1', format: 'json' }));
    expect(r.status).toBe(201);
    expect((await r.json()).id).toBe('exp-1');
    expect(recordUsage).toHaveBeenCalledWith('user-1', 'compliance_report');
  });

  it('★超限 EvidenceTooLargeError → 413', async () => {
    vi.mocked(createEvidenceExport).mockRejectedValue(new EvidenceTooLargeError(99999, 50000));
    const r = await POST(post({ format: 'json' }));
    expect(r.status).toBe(413);
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('policy_not_found → 404', async () => {
    vi.mocked(createEvidenceExport).mockRejectedValue(new Error('policy_not_found'));
    const r = await POST(post({ policyId: 'nope', format: 'json' }));
    expect(r.status).toBe(404);
  });

  it('非法 format → 默认 json（不报错）', async () => {
    vi.mocked(createEvidenceExport).mockResolvedValue({ id: 'x', manifest: {} as never });
    await POST(post({ format: 'weird' }));
    expect(createEvidenceExport).toHaveBeenCalledWith('user-1', expect.objectContaining({ format: 'json' }));
  });
});
