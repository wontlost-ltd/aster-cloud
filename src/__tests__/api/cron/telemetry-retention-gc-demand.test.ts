// telemetry-retention-gc 同一 tick 清理需求验证数据（ProductEvent 13 个月、PilotApplication 24 个月）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  gc: vi.fn(),
  events: vi.fn(),
  apps: vi.fn(),
  isSaas: true,
}));

vi.mock('@/lib/cron-auth', () => ({ requireCronAuth: m.auth }));
vi.mock('@/lib/telemetry/access-audit', () => ({ runRetentionGc: m.gc }));
vi.mock('@/lib/cron-lease', () => ({
  runCronOnce: async (_job: string, fn: () => Promise<unknown>) => ({ ran: true, result: await fn(), windowStart: 'w' }),
}));
vi.mock('@/lib/cron-window', () => ({ parseCronWindow: () => ({ acquiredBy: 'test', windowStart: undefined }) }));
vi.mock('@/lib/product-events/server', () => ({ purgeExpiredProductEvents: m.events }));
vi.mock('@/lib/pilot-applications', () => ({ purgeExpiredPilotApplications: m.apps }));
vi.mock('@/lib/deployment-mode', () => ({ get IS_SAAS() { return m.isSaas; } }));

import { POST } from '@/app/api/cron/telemetry-retention-gc/route';

beforeEach(() => {
  vi.clearAllMocks();
  m.isSaas = true;
  m.auth.mockReturnValue(null);
  m.gc.mockResolvedValue({ telemetryDeleted: 1 });
  m.events.mockResolvedValue(7);
  m.apps.mockResolvedValue(2);
});

describe('POST /api/cron/telemetry-retention-gc — 需求验证数据保留期', () => {
  it('同一次运行清理产品事件与试点申请，并在结果里给出数量', async () => {
    const res = await POST(new NextRequest('http://localhost/api/cron/telemetry-retention-gc', { method: 'POST' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.telemetryDeleted).toBe(1);
    expect(body.demandValidation).toEqual({ productEventsDeleted: 7, pilotApplicationsDeleted: 2 });
  });

  it('cron 鉴权失败时不清理', async () => {
    m.auth.mockReturnValue(new Response(null, { status: 401 }));
    const res = await POST(new NextRequest('http://localhost/api/cron/telemetry-retention-gc', { method: 'POST' }));
    expect(res.status).toBe(401);
    expect(m.events).not.toHaveBeenCalled();
    expect(m.apps).not.toHaveBeenCalled();
  });
});
