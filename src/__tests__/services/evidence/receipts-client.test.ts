// @vitest-environment node
// 服务端模块：node 环境下 getApiConfig 走 ASTER_POLICY_API_INTERNAL_URL（jsdom 有 window 会走公开地址）。
// 链收据客户端单测（ADR 0041 §2.4）：分批、有界并发、失败整批记 unavailable、missing 透传、内部签名头。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// server-only 由 Next 构建期别名提供（未作为依赖安装），测试中以空模块替代。
vi.mock('server-only', () => ({}));

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
  mergeLookups,
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

  it('450 个 id 分 9 批、每批 ≤ 50、在途并发 ≤ 4', async () => {
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

    expect(RECEIPT_BATCH).toBe(50);
    expect(fetchImpl).toHaveBeenCalledTimes(9);
    expect(sizes.every((s) => s <= RECEIPT_BATCH)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(450);
    expect(peak).toBeLessThanOrEqual(4);
    expect(out.receipts.size).toBe(450);
    expect(out.receipts.get('c-449')?.currentHash).toBe('h-c-449');
    expect(out.unavailable.size).toBe(0);
  });

  it('1500 个 id（30 批）在途并发峰值恰为 4', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return okFor(batchOf(String(url)));
    }) as unknown as typeof fetch;

    let calls = 0;
    const counted = ((u: string | URL | Request) => (calls++, fetchImpl(u))) as unknown as typeof fetch;
    const out = await fetchReceipts('t-1', ids(1500), counted);
    expect(calls).toBe(30);
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
    expect(out.unavailable.size).toBe(50);
    expect(out.receipts.size).toBe(400);
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
    // 假定时器也会接管 performance.now，故先绑定真实时钟再开启假定时器。
    const realNow = performance.now.bind(performance);
    vi.useFakeTimers();
    // 永不自行 resolve；仅在 abort 信号触发时以 AbortError 拒绝（模拟真实 fetch 行为）。
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;

    const t0 = realNow();
    const pending = fetchReceipts('t-1', ids(2), fetchImpl);
    await vi.advanceTimersByTimeAsync(RECEIPT_TIMEOUT_MS + 10);
    const out = await pending;
    const elapsed = realNow() - t0;
    // 证明超时由假定时器驱动，而非真实等待 2 s。
    console.info(`[timeout-test] real elapsed ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(100);
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

  it('服务端把同一 id 同时列入 receipts 与 missing ⇒ 收据优先', async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        receipts: [{
          auditId: 1, correlationId: 'c-0', currentHash: 'h', prevHash: null, hashVersion: 2,
          eventType: 'POLICY_EVALUATION', timestamp: '2026-10-01T00:00:00Z', metadata: {},
        }],
        approvals: [],
        missing: ['c-0'],
      })) as unknown as typeof fetch;
    const out = await fetchReceipts('t-1', ['c-0'], fetchImpl);
    expect(out.receipts.has('c-0')).toBe(true);
    expect(out.missing.has('c-0')).toBe(false);
  });

  it('服务端两边都未列出的 id ⇒ missing；批外 id 被忽略', async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        receipts: [{
          auditId: 1, correlationId: 'stranger', currentHash: 'h', prevHash: null, hashVersion: 2,
          eventType: 'POLICY_EVALUATION', timestamp: '2026-10-01T00:00:00Z', metadata: {},
        }],
        approvals: [],
        missing: ['other'],
      })) as unknown as typeof fetch;
    const out = await fetchReceipts('t-1', ['c-0'], fetchImpl);
    expect([...out.missing]).toEqual(['c-0']);
    expect(out.receipts.size).toBe(0);
    expect(out.unavailable.size).toBe(0);
  });

  it('响应畸形 ⇒ 整批 unavailable，不泄漏部分收据', async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        receipts: [{
          auditId: 1, correlationId: 'c-0', currentHash: 'h', prevHash: null, hashVersion: 2,
          eventType: 'POLICY_EVALUATION', timestamp: '2026-10-01T00:00:00Z', metadata: {},
        }],
        approvals: 'not-an-array',
        missing: [],
      })) as unknown as typeof fetch;
    const out = await fetchReceipts('t-1', ['c-0', 'c-1'], fetchImpl);
    expect([...out.unavailable].sort()).toEqual(['c-0', 'c-1']);
    expect(out.receipts.size).toBe(0);
    expect(out.missing.size).toBe(0);

    const notArray = (async () => jsonResponse({ receipts: {}, missing: [] })) as unknown as typeof fetch;
    const out2 = await fetchReceipts('t-1', ['c-0'], notArray);
    expect([...out2.unavailable]).toEqual(['c-0']);
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

describe('mergeLookups', () => {
  it('并集合并各租户的 receipts/missing/unavailable，同 decisionId 的审批拼接', () => {
    const approval = (auditId: number) => ({
      auditId, decisionId: 'd-1', outcome: 'APPROVED', decidedBy: 'u', requiredRole: null, comment: null,
      decidedAt: '2026-10-01T00:00:00Z', currentHash: `h${auditId}`, decisionReceiptHash: null,
    });
    const receipt = { auditId: 1, currentHash: 'h1', prevHash: null, hashVersion: 2, eventType: 'E', timestamp: 't', metadata: {} };
    const merged = mergeLookups([
      { receipts: new Map([['c-1', receipt]]), approvals: new Map([['d-1', [approval(1)]]]), missing: new Set(['c-2']), unavailable: new Set() },
      { receipts: new Map(), approvals: new Map([['d-1', [approval(2)]]]), missing: new Set(), unavailable: new Set(['c-3']) },
    ]);
    expect(merged.receipts.get('c-1')).toBe(receipt);
    expect(merged.approvals.get('d-1')!.map((a) => a.auditId)).toEqual([1, 2]);
    expect([...merged.missing]).toEqual(['c-2']);
    expect([...merged.unavailable]).toEqual(['c-3']);
  });

  it('空输入 → 空查找结果', () => {
    const merged = mergeLookups([]);
    expect(merged.receipts.size + merged.approvals.size + merged.missing.size + merged.unavailable.size).toBe(0);
  });
});
