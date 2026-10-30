// 回收站 30 天自动清理的 cron 路由（#623）：此前 cleanupExpiredTrashItems 没有任何调用方，
// 回收站无限累积。路由要求 cron 鉴权，经租约去重后清理过期项，并回收已删策略留下的孤儿访问记录。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const h = vi.hoisted(() => ({
  requireCronAuth: vi.fn(),
  runCronOnce: vi.fn(),
  cleanupExpiredTrashItems: vi.fn(),
  purgeOrphanPolicyAccessRows: vi.fn(),
}));

vi.mock('@/lib/cron-auth', () => ({ requireCronAuth: h.requireCronAuth }));
vi.mock('@/lib/cron-lease', () => ({ runCronOnce: h.runCronOnce }));
vi.mock('@/lib/policy-lifecycle', () => ({
  cleanupExpiredTrashItems: h.cleanupExpiredTrashItems,
  purgeOrphanPolicyAccessRows: h.purgeOrphanPolicyAccessRows,
}));

import { POST } from '@/app/api/cron/policy-trash-cleanup/route';

const req = () =>
  new NextRequest('http://localhost/api/cron/policy-trash-cleanup', {
    method: 'POST',
    headers: { 'x-cron-window-start': '2026-10-31T04:45:00.000Z' },
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.requireCronAuth.mockReturnValue(null);
  h.runCronOnce.mockImplementation(async (_job: string, fn: () => Promise<unknown>, opts: { windowStart?: Date }) => ({
    ran: true,
    result: await fn(),
    windowStart: opts.windowStart,
    leaseId: 'lease-1',
  }));
  h.cleanupExpiredTrashItems.mockResolvedValue({ deletedCount: 2, errors: [] });
  h.purgeOrphanPolicyAccessRows.mockResolvedValue({ shares: 1, reviewers: 0, invitations: 3 });
});

describe('POST /api/cron/policy-trash-cleanup', () => {
  it('未通过 cron 鉴权 → 原样返回鉴权响应，不清理', async () => {
    h.requireCronAuth.mockReturnValue(NextResponse.json({ error: 'unauthorized' }, { status: 401 }));
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(h.runCronOnce).not.toHaveBeenCalled();
    expect(h.cleanupExpiredTrashItems).not.toHaveBeenCalled();
  });

  it('以 policy-trash-cleanup 租约运行：清理过期项并回收孤儿访问记录', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(h.runCronOnce).toHaveBeenCalledWith('policy-trash-cleanup', expect.any(Function), expect.anything());
    expect(await res.json()).toMatchObject({
      ok: true,
      ran: true,
      deletedCount: 2,
      errorCount: 0,
      orphans: { shares: 1, reviewers: 0, invitations: 3 },
    });
  });

  it('部分项清理失败 → 仍返回 200 与错误数，错误详情只写日志', async () => {
    h.cleanupExpiredTrashItems.mockResolvedValue({ deletedCount: 1, errors: ['Failed to delete policy p9: boom'] });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: false, deletedCount: 1, errorCount: 1 });
    expect(JSON.stringify(body)).not.toContain('boom');
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('同一窗口已运行 → 跳过', async () => {
    h.runCronOnce.mockResolvedValue({ ran: false, skippedReason: 'already_ran', leaseId: 'l0' });
    const body = await (await POST(req())).json();
    expect(body).toMatchObject({ ok: true, ran: false, reason: 'already_ran' });
    expect(h.cleanupExpiredTrashItems).not.toHaveBeenCalled();
  });
});
