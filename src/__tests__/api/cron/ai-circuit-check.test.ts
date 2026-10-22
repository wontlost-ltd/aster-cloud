// 成本熔断 cron（review I5）：管理员手动熔断生效期间，cron 按手动熔断（最高档）补打 ban，
// 覆盖熔断后才注册或降级进 Free/Trial 的用户；没有手动熔断时仍按今日成本判定。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  todayPlatformCostCents: vi.fn(),
  getManualTripUntil: vi.fn(),
  applyCircuit: vi.fn(),
}));

vi.mock('@/lib/cron-auth', () => ({ requireCronAuth: vi.fn(() => null) }));
vi.mock('@/lib/ai-circuit-breaker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai-circuit-breaker')>();
  return {
    evaluateCircuit: actual.evaluateCircuit,
    CIRCUIT_BREAKER_THRESHOLDS: actual.CIRCUIT_BREAKER_THRESHOLDS,
    todayPlatformCostCents: h.todayPlatformCostCents,
    getManualTripUntil: h.getManualTripUntil,
    applyCircuit: h.applyCircuit,
  };
});
vi.mock('@/lib/prisma', () => ({ db: {} }));

import { GET } from '@/app/api/cron/ai-circuit-check/route';

const req = () => new Request('http://localhost/api/cron/ai-circuit-check') as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  h.applyCircuit.mockResolvedValue({ affected: 2 });
});

describe('GET /api/cron/ai-circuit-check', () => {
  it('★手动熔断生效且成本正常 → 按手动熔断补打最高档 ban，不清除', async () => {
    h.todayPlatformCostCents.mockResolvedValue(0);
    h.getManualTripUntil.mockResolvedValue(new Date(Date.now() + 3_600_000));

    const body = await (await GET(req())).json();

    expect(h.applyCircuit).toHaveBeenCalledWith('free_trial_stopped', { manual: true });
    expect(body).toMatchObject({ state: 'free_trial_stopped', manual: true, affected: 2 });
  });

  it('无手动熔断 → 按今日成本判定（成本正常时不打 ban）', async () => {
    h.todayPlatformCostCents.mockResolvedValue(0);
    h.getManualTripUntil.mockResolvedValue(null);
    h.applyCircuit.mockResolvedValue({ affected: 0 });

    const body = await (await GET(req())).json();

    expect(h.applyCircuit).toHaveBeenCalledWith('closed', { manual: false });
    expect(body).toMatchObject({ state: 'closed', manual: false });
  });
});
