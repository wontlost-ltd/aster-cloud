// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 对账客户端方法（ADR 0054 §10.2 / ADR 0061 §3.2）：真实 HMAC v3 签名器；签名内的 X-User-Role 即构造时的角色。

vi.mock('server-only', () => ({}));
vi.mock('@/lib/trace-context', () => ({ newTraceContext: () => ({ traceparent: '00-abc-def-01' }) }));
vi.mock('@/lib/business-roles', () => ({ loadBusinessRoles: async () => [] }));

import { createHash, createHmac } from 'node:crypto';
import { PolicyApiClient, PolicyApiError, GUARD_TIMEOUT_MS } from '@/services/policy/policy-api';
import { createPolicyApiClientForUser } from '@/lib/policy-api-identity';
import { DEFAULT_ORPHAN_QUERY } from '@/lib/guard-reconciliation/query';

const INTERNAL_KEY = 'test-internal-key';

function recomputeV3(method: string, url: string, body: string | undefined, headers: Record<string, string>): string {
  const u = new URL(url);
  const bodyHash = createHash('sha256').update(body ?? '').digest('hex');
  const canonical = [
    method, u.pathname, u.search.slice(1), headers['X-Aster-Timestamp'], headers['X-Aster-Nonce'], bodyHash,
    headers['X-Tenant-Id'], headers['X-User-Role'], headers['X-User-Id'], headers['X-User-Business-Roles'] ?? '',
  ].join('\n');
  return createHmac('sha256', INTERNAL_KEY).update(canonical).digest('hex');
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, statusText: 'x', json: async () => body };
}

describe('PolicyApiClient 对账方法', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const prevKey = process.env.ASTER_PLAN_GATE_HMAC_KEY;

  beforeEach(() => {
    process.env.ASTER_PLAN_GATE_HMAC_KEY = INTERNAL_KEY;
    fetchMock = vi.fn(async () => jsonResponse(200, { items: [] }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (prevKey === undefined) delete process.env.ASTER_PLAN_GATE_HMAC_KEY;
    else process.env.ASTER_PLAN_GATE_HMAC_KEY = prevKey;
  });

  function lastCall() {
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return { url, init, headers: init.headers as Record<string, string> };
  }

  it.each(['member', 'admin', 'owner'])('listGuardOrphans：GET 缺省查询，签名的 X-User-Role = %s', async (role) => {
    await new PolicyApiClient('team1', 'u-1', role).listGuardOrphans({ ...DEFAULT_ORPHAN_QUERY });

    const { url, init, headers } = lastCall();
    expect(url).toMatch(/\/api\/v1\/guard\/reconciliation\/orphans\?status=OPEN&severity=critical%2Cwarning&limit=50$/);
    expect(init.method).toBe('GET');
    expect(headers['X-User-Role']).toBe(role);
    expect(headers['X-Internal-Caller']).toBe('cloud-bff');
    expect(headers['X-Internal-Signature']).toBe(recomputeV3('GET', url, undefined, headers));
  });

  it('getGuardReconciliation：GET 摘要端点，guard 超时', async () => {
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { lastRun: null, open: {}, openTotal: 0, resultGrace: 'PT15M', lookback: 'P7D' }));
    const summary = await new PolicyApiClient('team1', 'u-1', 'admin').getGuardReconciliation();
    expect(summary.openTotal).toBe(0);
    expect(lastCall().url).toMatch(/\/api\/v1\/guard\/reconciliation$/);
    expect(timeout.mock.calls.some((c) => c[1] === GUARD_TIMEOUT_MS)).toBe(true);
  });

  it('ackGuardOrphan：POST { comment }，签名覆盖请求体与角色', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 7, status: 'ACKNOWLEDGED' }));
    await new PolicyApiClient('team1', 'u-1', 'admin').ackGuardOrphan(7, '已核实');
    const { url, init, headers } = lastCall();
    expect(url).toMatch(/\/api\/v1\/guard\/reconciliation\/orphans\/7\/ack$/);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"comment":"已核实"}');
    expect(headers['X-User-Role']).toBe('admin');
    expect(headers['X-Internal-Signature']).toBe(recomputeV3('POST', url, init.body as string, headers));
  });

  it.each([0, -1, 1.5, Number.NaN, 2 ** 53])('ackGuardOrphan(%s) 本地 400 invalid_id，不发请求', async (id) => {
    const err = await new PolicyApiClient('t', 'u', 'admin').ackGuardOrphan(id, 'x').catch((e) => e);
    expect(err).toBeInstanceOf(PolicyApiError);
    expect(err).toMatchObject({ statusCode: 400, code: 'invalid_id' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('409 not_open → PolicyApiError，details.status 为当前状态', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(409, { error: 'not_open', status: 'RESOLVED' }));
    const err = await new PolicyApiClient('t', 'u', 'admin').ackGuardOrphan(3, 'x').catch((e) => e);
    expect(err).toMatchObject({ statusCode: 409, code: 'not_open', details: { error: 'not_open', status: 'RESOLVED' } });
  });

  it('回归：createPolicyApiClientForUser 缺省第三参数仍签 member', async () => {
    const client = await createPolicyApiClientForUser('team1', 'u-1');
    await client.getGuardDecision('d-1');
    expect(lastCall().headers['X-User-Role']).toBe('member');
    const admin = await createPolicyApiClientForUser('team1', 'u-1', 'admin');
    await admin.getGuardDecision('d-1');
    expect(lastCall().headers['X-User-Role']).toBe('admin');
  });
});
