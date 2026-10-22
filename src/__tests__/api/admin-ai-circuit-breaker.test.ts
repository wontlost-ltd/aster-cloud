import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

/**
 * /api/admin/ai-circuit-breaker（F18）：GET 与管理员概览同源；POST 支持手动熔断与解除，
 * 二者都仅限管理员并写审计日志。
 */
vi.mock('@/lib/admin-auth', () => ({ requireAdmin: vi.fn() }));
vi.mock('@/lib/license-write-gate', () => ({ requireLicenseWriteOk: vi.fn(async () => null) }));
vi.mock('@/lib/audit-log', () => ({
  logAuditEvent: vi.fn(async () => undefined),
  extractClientInfo: () => ({ ipAddress: undefined, userAgent: undefined }),
}));
vi.mock('@/lib/ai-circuit-breaker', () => ({
  getCircuitStatus: vi.fn(),
  releaseCircuit: vi.fn(),
  tripCircuitManually: vi.fn(),
  CIRCUIT_BREAKER_THRESHOLDS: { freeStop: 20000, trialStop: 50000 },
}));

import { GET, POST } from '@/app/api/admin/ai-circuit-breaker/route';
import { requireAdmin } from '@/lib/admin-auth';
import { logAuditEvent } from '@/lib/audit-log';
import { getCircuitStatus, releaseCircuit, tripCircuitManually } from '@/lib/ai-circuit-breaker';

const post = (body: unknown) =>
  new Request('http://localhost/api/admin/ai-circuit-breaker', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET', () => {
  it('返回统一状态来源的取值（页面不再落到 "—"）', async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce({ userId: 'admin-1' } as never);
    vi.mocked(getCircuitStatus).mockResolvedValueOnce({
      todayCents: 1234,
      state: 'free_trial_stopped',
      costState: 'closed',
      banState: 'free_trial_stopped',
      manual: true,
      bannedUsers: 3,
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      today_usd: '12.34',
      state: 'free_trial_stopped',
      ban_state: 'free_trial_stopped',
      manual: true,
      banned_users: 3,
      thresholds: { free_stop_usd: 200, trial_stop_usd: 500 },
    });
  });
});

describe('POST', () => {
  it('非管理员被拒，不执行任何熔断操作', async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce(
      NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    );
    const res = await POST(post({ action: 'trip' }));
    expect(res.status).toBe(403);
    expect(tripCircuitManually).not.toHaveBeenCalled();
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it('★trip：手动熔断并写审计日志', async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce({ userId: 'admin-1' } as never);
    vi.mocked(tripCircuitManually).mockResolvedValueOnce({ affected: 5 });
    const res = await POST(post({ action: 'trip' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, affected: 5 });
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-1', action: 'ai-circuit.trip', resource: 'ai-circuit-breaker' }),
    );
  });

  it('release：解除并写审计日志', async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce({ userId: 'admin-1' } as never);
    vi.mocked(releaseCircuit).mockResolvedValueOnce({ released: 5 });
    const res = await POST(post({ action: 'release' }));
    expect(await res.json()).toEqual({ ok: true, released: 5 });
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ai-circuit.release', metadata: { released: 5 } }),
    );
  });

  it('未知 action → 400', async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce({ userId: 'admin-1' } as never);
    const res = await POST(post({ action: 'explode' }));
    expect(res.status).toBe(400);
  });
});
