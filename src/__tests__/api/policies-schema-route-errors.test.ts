// POST /api/policies/schema 兜底分支不回传原始错误（#662）；上游 API 的业务错误照常透传。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getSchema = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth', () => ({ getSession: vi.fn(async () => ({ user: { id: 'u1' } })) }));
vi.mock('@/services/policy/policy-api', async () => {
  class PolicyApiError extends Error {
    constructor(message: string, readonly statusCode: number, readonly code?: string) {
      super(message);
    }
  }
  return { PolicyApiError, createPolicyApiClient: () => ({ getSchema }) };
});

import { POST } from '@/app/api/policies/schema/route';
import { PolicyApiError } from '@/services/policy/policy-api';

function req() {
  return new Request('http://localhost/api/policies/schema', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'Module m.' }),
  });
}

describe('POST /api/policies/schema 错误响应', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    getSchema.mockReset();
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => consoleError.mockRestore());

  it('未识别异常 → 500 通用文案，不含原始消息', async () => {
    getSchema.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.12:5432'));
    const res = await POST(req());
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).not.toContain('ECONNREFUSED');
    expect(JSON.parse(text)).toMatchObject({ success: false, code: 'internal_error' });
  });

  // #711：上游错误原文（可能是中文、内部类名或主机地址）只进服务端日志
  type Ctor = new (m: string, s: number, c?: string) => Error;
  const apiError = (m: string, st: number, c?: string) => new (PolicyApiError as unknown as Ctor)(m, st, c);

  it('上游 4xx 业务拒绝 → 保留状态码，稳定 code + 英文文案，不回传原文', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getSchema.mockRejectedValue(apiError('未找到规则 io.aster.SchemaService', 404));
    const res = await POST(req());
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body).toEqual({
      success: false,
      error: 'schema_request_rejected',
      code: 'schema_request_rejected',
      message: 'The policy schema could not be extracted from this source.',
    });
    warn.mockRestore();
  });

  it.each([
    ['5xx', 503, undefined],
    ['客户端超时', 408, 'TIMEOUT'],
    ['网络错误', 500, 'UNKNOWN'],
    ['身份配置问题', 401, undefined],
  ])('上游不可用（%s）→ 502 upstream_unavailable + requestId，不回传原文', async (_n, status, code) => {
    getSchema.mockRejectedValue(apiError('connect ECONNREFUSED 10.43.0.9:8080', status as number, code as string | undefined));
    const res = await POST(req());
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body).toMatchObject({ success: false, error: 'upstream_unavailable', code: 'upstream_unavailable' });
    expect(body.message).toBe('The policy engine could not be reached. Please try again later.');
    expect(JSON.stringify(body)).not.toContain('10.43.0.9');
    expect(res.headers.get('x-request-id')).toBe(body.requestId);
    expect(JSON.stringify(consoleError.mock.calls)).toContain(body.requestId);
  });
});
