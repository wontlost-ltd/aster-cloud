// @vitest-environment node
// What-If 回放条目客户端单测（ADR 0044 §3）：解析、归一、整批 unavailable、分批。

import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/api-signing', () => ({
  signInternalCallerHeaders: vi.fn(async () => ({ 'X-Aster-Signature': 'sig-hex' })),
}));

import { fetchReplayItems, mergeReplayLookups } from '@/services/evidence/replay-items-client';
import { RECEIPT_BATCH } from '@/services/evidence/receipts-client';

const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

describe('fetchReplayItems', () => {
  it('解析 items 为 map，缺失的 id 不出现也不算 unavailable', async () => {
    const fetchImpl = vi.fn(() => ok({ items: [
      { executionId: 'e1', batchId: 'b1', baseOutcome: 'REQUIRE_APPROVAL', targetOutcome: 'ALLOW', baseLegacy: false },
    ] }));
    const r = await fetchReplayItems('t', ['e1', 'e2'], fetchImpl as unknown as typeof fetch);
    expect(r.items.get('e1')).toEqual({ batchId: 'b1', baseOutcome: 'REQUIRE_APPROVAL', targetOutcome: 'ALLOW', baseLegacy: false });
    expect(r.items.has('e2')).toBe(false);
    expect(r.unavailable.size).toBe(0);
  });
  it('非 2xx 整批 unavailable', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('x', { status: 503 })));
    const r = await fetchReplayItems('t', ['e1', 'e2'], fetchImpl as unknown as typeof fetch);
    expect([...r.unavailable]).toEqual(['e1', 'e2']);
  });
  it('targetOutcome 缺省归一为 null', async () => {
    const fetchImpl = vi.fn(() => ok({ items: [{ executionId: 'e1', batchId: 'b1', baseOutcome: 'ALLOW', baseLegacy: true }] }));
    const r = await fetchReplayItems('t', ['e1'], fetchImpl as unknown as typeof fetch);
    expect(r.items.get('e1')?.targetOutcome).toBeNull();
  });
  it('任一项畸形 ⇒ 整批 unavailable 且无部分写入', async () => {
    const fetchImpl = vi.fn(() => ok({ items: [
      { executionId: 'e1', batchId: 'b1', baseOutcome: 'ALLOW', baseLegacy: false },
      { executionId: 'e2', batchId: 'b1', baseOutcome: 'ALLOW', baseLegacy: 'no' },
    ] }));
    const r = await fetchReplayItems('t', ['e1', 'e2'], fetchImpl as unknown as typeof fetch);
    expect(r.items.size).toBe(0);
    expect([...r.unavailable]).toEqual(['e1', 'e2']);
  });
  it('items 非数组 ⇒ 整批 unavailable', async () => {
    const fetchImpl = vi.fn(() => ok({ items: {} }));
    const r = await fetchReplayItems('t', ['e1'], fetchImpl as unknown as typeof fetch);
    expect([...r.unavailable]).toEqual(['e1']);
  });
  it('网络错误 ⇒ 整批 unavailable，不重试', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('boom')));
    const r = await fetchReplayItems('t', ['e1'], fetchImpl as unknown as typeof fetch);
    expect([...r.unavailable]).toEqual(['e1']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('按 RECEIPT_BATCH 分批，忽略未请求的 id', async () => {
    const ids = Array.from({ length: RECEIPT_BATCH + 1 }, (_, i) => `e${i}`);
    const fetchImpl = vi.fn(() => ok({ items: [
      { executionId: 'stranger', batchId: 'b', baseOutcome: 'ALLOW', baseLegacy: false },
    ] }));
    const r = await fetchReplayItems('t', ids, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(r.items.size).toBe(0);
  });
});

describe('mergeReplayLookups', () => {
  it('并集合并', () => {
    const wi = { batchId: 'b', baseOutcome: 'ALLOW', targetOutcome: null, baseLegacy: false };
    const m = mergeReplayLookups([
      { items: new Map([['a', wi]]), unavailable: new Set(['x']) },
      { items: new Map([['b', wi]]), unavailable: new Set(['y']) },
    ]);
    expect([...m.items.keys()]).toEqual(['a', 'b']);
    expect([...m.unavailable]).toEqual(['x', 'y']);
  });
});
