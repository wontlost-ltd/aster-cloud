// @vitest-environment node
// 服务端模块：node 环境下 getApiConfig 走 ASTER_POLICY_API_INTERNAL_URL（jsdom 有 window 会走公开地址）。
// 链收据客户端单测（ADR 0041 §2.4）：分批、有界并发、失败整批记 unavailable、missing 透传、内部签名头。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/api-signing', () => ({
  signInternalCallerHeaders: vi.fn(async () => ({
    'X-Aster-Caller': 'aster-cloud',
    'X-Aster-Timestamp': '1700000000',
    'X-Aster-Signature': 'sig-hex',
  })),
}));

import {
  fetchReceipts,
  fetchDecisionReceipts,
  RECEIPT_BATCH,
  RECEIPT_TIMEOUT_MS,
} from '@/services/evidence/receipts-client';
import { signInternalCallerHeaders } from '@/lib/api-signing';

const ids = (n: number, prefix = 'c') => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

/** 从请求 URL 解出本批 id。 */
function batchOf(url: string, param = 'correlationIds'): string[] {
  return (new URL(url).searchParams.get(param) ?? '').split(',').filter(Boolean);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** 每个 id 都回一条收据的默认响应。 */
function okFor(batch: string[]): Response {
  return jsonResponse({
    receipts: batch.map((id, i) => ({
      auditId: i + 1, correlationId: id, currentHash: `h-${id}`, prevHash: null, hashVersion: 2,
      eventType: 'POLICY_EVALUATION', timestamp: '2026-10-01T00:00:00Z', metadata: {},
    })),
    approvals: [],
    missing: [],
  });
}

describe('receipts-client', () => {
  beforeEach(() => {
    process.env.ASTER_PLAN_GATE_HMAC_KEY = 'test-key';
    process.env.ASTER_POLICY_API_INTERNAL_URL = 'http://api.internal';
    vi.mocked(signInternalCallerHeaders).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.ASTER_PLAN_GATE_HMAC_KEY;
    delete process.env.ASTER_POLICY_API_INTERNAL_URL;
  });

  it('450 个 id 分 3 批、每批 ≤ 200、在途并发 ≤ 4', async () => {
    let inFlight = 0;
    let peak = 0;
    const sizes: number[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      const batch = batchOf(String(url));
      sizes.push(batch.length);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return okFor(batch);
    }) as unknown as typeof fetch;

    const out = await fetchReceipts('t-1', ids(450), fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sizes.every((s) => s <= RECEIPT_BATCH)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(450);
    expect(peak).toBeLessThanOrEqual(4);
    expect(out.receipts.size).toBe(450);
    expect(out.receipts.get('c-449')?.currentHash).toBe('h-c-449');
    expect(out.unavailable.size).toBe(0);
  });

  it('超过 4 批时在途并发仍 ≤ 4', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return okFor(batchOf(String(url)));
    }) as unknown as typeof fetch;

    const out = await fetchReceipts('t-1', ids(1500), fetchImpl);
    expect(peak).toBe(4);
    expect(out.receipts.size).toBe(1500);
  });

  it('一批 503 ⇒ 该批 id 全进 unavailable，其余正常', async () => {
    let call = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const batch = batchOf(String(url));
      return call++ === 1 ? new Response('down', { status: 503 }) : okFor(batch);
    }) as unknown as typeof fetch;

    const out = await fetchReceipts('t-1', ids(450), fetchImpl);
    expect(out.unavailable.size).toBe(200);
    expect(out.receipts.size).toBe(250);
    for (const id of out.unavailable) expect(out.receipts.has(id)).toBe(false);
  });

  it('网络错 ⇒ 该批 unavailable、不重试', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const out = await fetchReceipts('t-1', ids(3), fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect([...out.unavailable].sort()).toEqual(['c-0', 'c-1', 'c-2']);
  });

  it('超时（fetch 永不 resolve）⇒ unavailable', async () => {
    vi.useFakeTimers();
    // 永不自行 resolve；仅在 abort 信号触发时以 AbortError 拒绝（模拟真实 fetch 行为）。
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;

    const pending = fetchReceipts('t-1', ids(2), fetchImpl);
    await vi.advanceTimersByTimeAsync(RECEIPT_TIMEOUT_MS + 10);
    const out = await pending;
    expect([...out.unavailable].sort()).toEqual(['c-0', 'c-1']);
    expect(out.receipts.size).toBe(0);
  });

  it('响应 missing 归入 missing', async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        receipts: [{
          auditId: 1, correlationId: 'c-0', currentHash: 'h', prevHash: null, hashVersion: 2,
          eventType: 'POLICY_EVALUATION', timestamp: '2026-10-01T00:00:00Z', metadata: {},
        }],
        approvals: [],
        missing: ['c-1'],
      })) as unknown as typeof fetch;

    const out = await fetchReceipts('t-1', ['c-0', 'c-1'], fetchImpl);
    expect(out.receipts.has('c-0')).toBe(true);
    expect([...out.missing]).toEqual(['c-1']);
    expect(out.unavailable.size).toBe(0);
  });

  it('请求头含租户/身份头与内部签名；URL 指向 receipts 端点', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => okFor(batchOf(String(url)))) as unknown as typeof fetch;
    await fetchReceipts('t-9', ['c-0'], fetchImpl);

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0];
    expect(String(url)).toBe('http://api.internal/api/v1/audit/receipts?correlationIds=c-0');
    const headers = init!.headers as Record<string, string>;
    expect(headers['X-Aster-Signature']).toBe('sig-hex');
    expect(headers['X-Tenant-Id']).toBe('t-9');
    expect(headers['X-User-Role']).toBe('member');
    expect(headers['X-User-Id']).toBeTruthy();
    expect(signInternalCallerHeaders).toHaveBeenCalledWith('GET', '/api/v1/audit/receipts', '', 't-9', 'member');
  });

  it('空 id / 重复 id：空不发请求，重复去重', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => okFor(batchOf(String(url)))) as unknown as typeof fetch;
    const empty = await fetchReceipts('t-1', [], fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(empty.receipts.size).toBe(0);

    await fetchReceipts('t-1', ['a', 'a', '', 'b'], fetchImpl);
    expect(batchOf(String(vi.mocked(fetchImpl).mock.calls[0][0]))).toEqual(['a', 'b']);
  });

  it('fetchDecisionReceipts：按 decisionId 建索引，approvals 按 decisionId 聚合', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        receipts: [{
          auditId: 7, decisionId: 'd-1', currentHash: 'hd', prevHash: 'hp', hashVersion: 2,
          eventType: 'APPROVAL_REQUESTED', timestamp: '2026-10-01T00:00:00Z', metadata: { k: 1 },
        }],
        approvals: [
          { auditId: 8, decisionId: 'd-1', outcome: 'APPROVED', decidedBy: 'u-1', requiredRole: 'risk', comment: null,
            decidedAt: '2026-10-01T01:00:00Z', currentHash: 'ha1', decisionReceiptHash: 'hd' },
          { auditId: 9, decisionId: 'd-1', outcome: 'APPROVED', decidedBy: 'u-2', requiredRole: null, comment: 'ok',
            decidedAt: '2026-10-01T02:00:00Z', currentHash: 'ha2', decisionReceiptHash: 'hd' },
        ],
        missing: [],
      })) as unknown as typeof fetch;

    const out = await fetchDecisionReceipts('t-1', ['d-1'], fetchImpl);
    expect(String(vi.mocked(fetchImpl).mock.calls[0][0])).toContain('decisionIds=d-1');
    expect(out.receipts.get('d-1')?.auditId).toBe(7);
    expect(out.approvals.get('d-1')?.map((a) => a.auditId)).toEqual([8, 9]);
  });
});
