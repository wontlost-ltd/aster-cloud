import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ★HMAC path 分歧守门（Codex 设计审 go/no-go）：aster-api InternalCallerFilter 签
// ctx.getUriInfo().getPath()=纯 path 不含 query；且 request() 内部签名只在 pathname 精确匹配
// evaluateSource 时才发。因此 replayCapture=true 的 ?replayCapture=true 必须**只进 fetch URL，
// 不进签名 path**。此测试锁定：fetch URL 含 query，signInternalCallerHeaders 收到的是纯 path，
// query 以 v3 的 identity.query 单独签入（ADR 0042 §4.1）。

// signInternalCallerHeaders(method, path, body, tenant, role, identity) → 内部签名头。
const signSpy = vi.fn(
  async (
    _method: string,
    _path: string,
    _body: string | undefined,
    _tenant: string,
    _role: string,
    _identity?: { query?: string; userId?: string; businessRoles?: string[] },
  ) => ({
    'X-Internal-Caller': 'cloud-bff',
    'X-Aster-Timestamp': '1',
    'X-Aster-Nonce': 'n',
    'X-Internal-Signature': 'sig',
  }),
);

vi.mock('@/lib/api-signing', () => ({
  signRequest: vi.fn(async () => ({})),
  signInternalCallerHeaders: (
    method: string,
    path: string,
    body: string | undefined,
    tenant: string,
    role: string,
    identity?: { query?: string; userId?: string; businessRoles?: string[] },
  ) => signSpy(method, path, body, tenant, role, identity),
}));

// trace-context 动态 import 需可用。
vi.mock('@/lib/trace-context', () => ({
  newTraceContext: () => ({ traceparent: '00-abc-def-01' }),
}));

import { PolicyApiClient } from '@/services/policy/policy-api';
import { API_ENDPOINTS } from '@/config/api-versions';

const EVAL_PATH = API_ENDPOINTS.evaluateSource; // /api/v1/policies/evaluate-source

describe('evaluateSource replayCapture — HMAC 纯路径签名不被 query 破坏', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const prevKey = process.env.ASTER_PLAN_GATE_HMAC_KEY;
  const prevHmac = process.env.ASTER_HMAC_SECRET;

  beforeEach(() => {
    signSpy.mockClear();
    process.env.ASTER_PLAN_GATE_HMAC_KEY = 'test-internal-key';
    delete process.env.ASTER_HMAC_SECRET; // 只测内部签名路径
    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result: 'APPROVED', executionTimeMs: 5, error: null }),
    }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevKey === undefined) delete process.env.ASTER_PLAN_GATE_HMAC_KEY;
    else process.env.ASTER_PLAN_GATE_HMAC_KEY = prevKey;
    if (prevHmac === undefined) delete process.env.ASTER_HMAC_SECRET;
    else process.env.ASTER_HMAC_SECRET = prevHmac;
  });

  it('replayCapture=true：fetch URL 含 ?replayCapture=true，但签名 path 是纯路径', async () => {
    const client = new PolicyApiClient('tenant-1', 'user-1', 'member');
    await client.evaluateSource('Module m. Rule r given x as Int: return "OK"', { x: 1 }, {
      replayCapture: true,
    });

    // fetch URL 必须带 query（aster-api @QueryParam("replayCapture") 接收）。
    const fetchedUrl = fetchMock.mock.calls[0][0] as string;
    expect(fetchedUrl).toContain('?replayCapture=true');
    expect(fetchedUrl).toContain(EVAL_PATH);

    // ★签名的 path 段（第 2 参）必须是纯路径，不含 ?replayCapture=true——否则 aster-api 侧
    // 用纯 path 重算签名会 mismatch → 403 invalid_signature。
    expect(signSpy).toHaveBeenCalledTimes(1);
    const signedPath = signSpy.mock.calls[0][1] as string;
    expect(signedPath).toBe(EVAL_PATH);
    expect(signedPath).not.toContain('?');
    expect(signedPath).not.toContain('replayCapture');
    // v3：query 与 userId 单独签入
    expect(signSpy.mock.calls[0][5]).toEqual({ query: 'replayCapture=true', userId: 'user-1', businessRoles: [] });
  });

  it('无 replayCapture：URL 无 query，签名 path 仍纯路径（回归）', async () => {
    const client = new PolicyApiClient('tenant-1', 'user-1', 'member');
    await client.evaluateSource('Module m. Rule r given x as Int: return "OK"', { x: 1 }, {});

    const fetchedUrl = fetchMock.mock.calls[0][0] as string;
    expect(fetchedUrl).not.toContain('?replayCapture');
    expect(signSpy).toHaveBeenCalledTimes(1);
    expect(signSpy.mock.calls[0][1]).toBe(EVAL_PATH);
    expect(signSpy.mock.calls[0][5]?.query).toBe('');
  });

  it('replayMetadata 透传：后端返回则 evaluateSource 结果携带', async () => {
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        result: 'APPROVED',
        executionTimeMs: 5,
        error: null,
        replayMetadata: {
          runtimeToolchainId: 'abi=V1;core=1.0.8',
          canonicalizationVersion: 'aster-canonical-json/v1',
          canonicalInputHash: 'aaa',
          canonicalOutputHash: 'bbb',
          traceHash: 'ccc',
          reasonCodes: [],
          replayabilityStatus: 'REPLAYABLE',
          replayabilityReasons: [],
        },
      }),
    }));
    const client = new PolicyApiClient('tenant-1', 'user-1', 'member');
    const resp = await client.evaluateSource('Module m. Rule r given x as Int: return "OK"', { x: 1 }, {
      replayCapture: true,
    });
    expect(resp.replayMetadata?.canonicalInputHash).toBe('aaa');
    expect(resp.replayMetadata?.replayabilityStatus).toBe('REPLAYABLE');
  });
});
