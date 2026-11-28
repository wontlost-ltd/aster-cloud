// @vitest-environment node
// guard-orphan-notify cron 路由（ADR 0065）：鉴权、开关关闭、报告透出、feed 失败走租约失败分支。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const h = vi.hoisted(() => ({
  requireCronAuth: vi.fn(),
  runCronOnce: vi.fn(),
  notifyOrphansDetected: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/cron-auth', () => ({ requireCronAuth: h.requireCronAuth }));
vi.mock('@/lib/cron-lease', () => ({ runCronOnce: h.runCronOnce }));
vi.mock('@/lib/guard-notifications', () => ({ notifyOrphansDetected: h.notifyOrphansDetected }));

import { POST } from '@/app/api/cron/guard-orphan-notify/route';
import { OrphanFeedError } from '@/lib/guard-orphan-notify/feed-client';

const req = () =>
  new NextRequest('http://localhost/api/cron/guard-orphan-notify', {
    method: 'POST',
    headers: { 'x-cron-window-start': '2026-11-28T10:02:00.000Z' },
  });

const report = (over: Record<string, unknown> = {}) => ({
  ran: true,
  tenantsIndexed: 3,
  pages: 1,
  tenantsWithNew: 2,
  noticesCreated: 2,
  recipients: 4,
  deferredQuiet: 0,
  deferredBacklog: 0,
  summaryFailed: 0,
  casLost: 0,
  noRecipients: 0,
  emailed: 0,
  maxLagSeconds: 30,
  oldestPendingSeconds: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.requireCronAuth.mockReturnValue(null);
  h.runCronOnce.mockImplementation(async (_job: string, fn: () => Promise<unknown>) => ({
    ran: true,
    result: await fn(),
    leaseId: 'lease-1',
  }));
  h.notifyOrphansDetected.mockResolvedValue(report());
});

describe('POST /api/cron/guard-orphan-notify', () => {
  it('未通过 cron 鉴权 → 401，不取租约', async () => {
    h.requireCronAuth.mockReturnValue(NextResponse.json({ error: 'unauthorized' }, { status: 401 }));
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(h.runCronOnce).not.toHaveBeenCalled();
  });

  it('租约未取得 → ran:false 并带 skippedReason', async () => {
    h.runCronOnce.mockResolvedValue({ ran: false, skippedReason: 'already-ran', leaseId: 'lease-0' });
    const res = await POST(req());
    expect(await res.json()).toEqual({ ok: true, ran: false, reason: 'already-ran', leaseId: 'lease-0' });
  });

  it('站内开关关闭 → ran:false, reason:disabled', async () => {
    h.notifyOrphansDetected.mockResolvedValue(report({ ran: false }));
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ran: false, reason: 'disabled', leaseId: 'lease-1' });
  });

  it('正常执行 → 报告字段透出，以 guard-orphan-notify 租约运行', async () => {
    const res = await POST(req());
    expect(h.runCronOnce).toHaveBeenCalledWith('guard-orphan-notify', expect.any(Function), expect.anything());
    expect(await res.json()).toMatchObject({ ok: true, ran: true, leaseId: 'lease-1', noticesCreated: 2, recipients: 4 });
  });

  it('summaryFailed > 0 → ok:false 且 console.error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.notifyOrphansDetected.mockResolvedValue(report({ summaryFailed: 2 }));
    const res = await POST(req());
    expect(await res.json()).toMatchObject({ ok: false, ran: true, summaryFailed: 2 });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('feed 403 marks lease failed：fn 抛错由 runCronOnce 标失败并重抛，路由不吞', async () => {
    const failed = vi.fn();
    h.notifyOrphansDetected.mockRejectedValue(new OrphanFeedError(403, 'forbidden'));
    h.runCronOnce.mockImplementation(async (_job: string, fn: () => Promise<unknown>) => {
      try {
        return { ran: true, result: await fn(), leaseId: 'lease-1' };
      } catch (e) {
        failed(e);
        throw e;
      }
    });
    await expect(POST(req())).rejects.toBeInstanceOf(OrphanFeedError);
    expect(failed).toHaveBeenCalledTimes(1);
  });
});
