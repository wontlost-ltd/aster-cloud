// POST /api/policies/schema 兜底分支不回传原始错误（#662）；上游 API 的业务错误照常透传。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getSchema = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth', () => ({ getSession: vi.fn(async () => ({ user: { id: 'u1' } })) }));
vi.mock('@/services/policy/policy-api', async () => {
  class PolicyApiError extends Error {
    constructor(message: string, readonly statusCode: number) {
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

  it('上游业务错误（PolicyApiError）→ 按其状态码透传消息', async () => {
    getSchema.mockRejectedValue(new (PolicyApiError as unknown as new (m: string, s: number) => Error)('Rule not found', 404));
    const res = await POST(req());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Rule not found');
  });
});
