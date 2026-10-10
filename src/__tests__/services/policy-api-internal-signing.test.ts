import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash, createHmac } from 'node:crypto';

// aster-api C3（RateLimitFilter）只对验签通过的 cloud-bff 内部调用按「调用方 × 已签名租户」分桶；
// 未签名请求全部落入同一出口 IP 桶。本文件锁定：客户端对 api 限流可分桶的每条调用都签 canonical v3，
// 签名与 api InternalCallerFilter.signatureMatches 的 canonical 逐字节一致；缺密钥时维持不签且只告警一次。

vi.mock('@/lib/trace-context', () => ({
  newTraceContext: () => ({ traceparent: '00-abc-def-01' }),
}));

const KEY = 's2-1a-0-characterization-key-32b!';
const TS_MS = 1_760_000_000_123;
const NONCE = 'ab'.repeat(16);

type FetchCall = [string, { method: string; headers: Record<string, string>; body?: string }];

function okResponse() {
  return { ok: true, status: 200, json: async () => ({ success: true }) };
}

// 按 api 侧 canonical v3 独立重算期望签名（不经过被测签名器）。
function apiSideSignature(url: string, init: FetchCall[1]): string {
  const parsed = new URL(url);
  const h = init.headers;
  const canonical = [
    init.method,
    parsed.pathname,
    parsed.search.slice(1),
    h['X-Aster-Timestamp'],
    h['X-Aster-Nonce'],
    createHash('sha256').update(init.body ?? '').digest('hex'),
    h['X-Tenant-Id'] ?? '',
    h['X-User-Role'] ?? '',
    h['X-User-Id'] ?? '',
    h['X-User-Business-Roles'] ?? '',
  ].join('\n');
  return createHmac('sha256', KEY).update(canonical).digest('hex');
}

describe('PolicyApiClient 内部调用签名（ADR 0046 D9）', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const prevKey = process.env.ASTER_PLAN_GATE_HMAC_KEY;
  const prevHmac = process.env.ASTER_HMAC_SECRET;

  async function newClient() {
    const { PolicyApiClient } = await import('@/services/policy/policy-api');
    return new PolicyApiClient('tenant-1', 'user-1', 'member', 'unknown', ['DPO', 'CISO']);
  }

  function lastCall(): FetchCall {
    return fetchMock.mock.calls.at(-1) as FetchCall;
  }

  beforeEach(() => {
    vi.resetModules();
    process.env.ASTER_PLAN_GATE_HMAC_KEY = KEY;
    delete process.env.ASTER_HMAC_SECRET;
    fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (prevKey === undefined) delete process.env.ASTER_PLAN_GATE_HMAC_KEY;
    else process.env.ASTER_PLAN_GATE_HMAC_KEY = prevKey;
    if (prevHmac === undefined) delete process.env.ASTER_HMAC_SECRET;
    else process.env.ASTER_HMAC_SECRET = prevHmac;
  });

  it('compile 固定向量：头与签名逐字节等于 api canonical v3', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(TS_MS);
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(arr: T): T => {
      (arr as unknown as Uint8Array).fill(0xab);
      return arr;
    });
    const client = await newClient();
    await client.compile({ source: 'Module m.' });

    const [url, init] = lastCall();
    expect(new URL(url).pathname).toBe('/api/v1/policies/compile');
    expect(init.body).toBe('{"source":"Module m.","locale":"en-US"}');
    expect(init.headers).toMatchObject({
      'X-Internal-Caller': 'cloud-bff',
      'X-Aster-Timestamp': '1760000000',
      'X-Aster-Nonce': NONCE,
      'X-Tenant-Id': 'tenant-1',
      'X-User-Role': 'member',
      'X-User-Id': 'user-1',
      'X-User-Business-Roles': 'CISO,DPO',
    });
    // canonical（body sha256 = ddb40f6c…3efe）：
    //   POST\n/api/v1/policies/compile\n\n1760000000\n<NONCE>\n<bodySha>\ntenant-1\nmember\nuser-1\nCISO,DPO
    // 期望值由 python hmac 独立算出，不得为迁就实现而修改。
    expect(init.headers['X-Internal-Signature']).toBe(
      '68713ca7dcdbc9047e0b40759e5cbd7dd620a66ec2e5c4412dcaf1c5e23fb564',
    );
  });

  it.each([
    ['evaluate', (c: Awaited<ReturnType<typeof newClient>>) =>
      c.evaluate({ policyModule: 'm', policyFunction: 'f', context: [{ a: 1 }] })],
    ['evaluateBatch', (c: Awaited<ReturnType<typeof newClient>>) =>
      c.evaluateBatch({ policyModule: 'm', policyFunction: 'f', contexts: [[{ a: 1 }]] })],
    ['getSchema', (c: Awaited<ReturnType<typeof newClient>>) => c.getSchema('Module m.')],
    ['getModuleCatalog', (c: Awaited<ReturnType<typeof newClient>>) => c.getModuleCatalog()],
  ])('%s 带可被 api 验签的内部头', async (_name, call) => {
    const client = await newClient();
    await call(client);

    const [url, init] = lastCall();
    expect(init.headers['X-Internal-Caller']).toBe('cloud-bff');
    expect(init.headers['X-Tenant-Id']).toBe('tenant-1');
    expect(init.headers['X-Internal-Signature']).toBe(apiSideSignature(url, init));
  });

  it('/q/ 健康检查被 api 限流豁免，不签', async () => {
    const client = await newClient();
    await client.healthCheck();

    expect(lastCall()[1].headers).not.toHaveProperty('X-Internal-Caller');
  });

  it('缺密钥：照常不签发出请求，且整个进程只告警一次', async () => {
    delete process.env.ASTER_PLAN_GATE_HMAC_KEY;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = await newClient();

    await client.compile({ source: 'Module m.' });
    await client.evaluate({ policyModule: 'm', policyFunction: 'f', context: [] });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls as FetchCall[]) {
      expect(init.headers).not.toHaveProperty('X-Internal-Caller');
      expect(init.headers).not.toHaveProperty('X-Internal-Signature');
    }
    const keyWarnings = warn.mock.calls.filter((args) => String(args[0]).includes('ASTER_PLAN_GATE_HMAC_KEY'));
    expect(keyWarnings).toHaveLength(1);
  });
});
