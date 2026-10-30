// /api/policies/evaluate-source 错误脱敏（#609）：Java 异常原文只进日志，CNL 语法错误原样保留供作者修改。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockEvaluateSource } = vi.hoisted(() => ({ mockEvaluateSource: vi.fn() }));

vi.mock('@/lib/auth', () => ({ getSession: vi.fn().mockResolvedValue({ user: { id: 'u1' } }) }));
// 执行配额由 evaluate-source-quota.test.ts 覆盖；此处恒放行
vi.mock('@/lib/usage', () => ({
  checkUsageLimit: vi.fn().mockResolvedValue({ allowed: true, limit: -1, remaining: -1 }),
  recordUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/services/policy/policy-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/policy/policy-api')>();
  return { ...actual, createPolicyApiClient: vi.fn(() => ({ evaluateSource: mockEvaluateSource })) };
});

import { POST } from '@/app/api/policies/evaluate-source/route';
import { PolicyApiError } from '@/services/policy/policy-api';

function request(): Request {
  return new Request('http://localhost/api/policies/evaluate-source', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'Module X.', context: {} }),
  });
}

describe('POST /api/policies/evaluate-source — 错误脱敏', () => {
  beforeEach(() => {
    mockEvaluateSource.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('Java 异常原文与诊断被替换', async () => {
    mockEvaluateSource.mockResolvedValue({
      result: null,
      executionTimeMs: 3,
      error: 'Polyglot 执行失败: java.lang.RuntimeException: boom',
      diagnostics: [{ code: 'RUNTIME', message: 'java.lang.RuntimeException: boom' }],
    });
    const res = await POST(request());
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(JSON.stringify(body)).not.toMatch(/java\.lang|Polyglot/);
    expect(body.diagnostics[0].code).toBe('RUNTIME');
  });

  it('CNL 语法错误原样返回', async () => {
    mockEvaluateSource.mockResolvedValue({
      result: null,
      executionTimeMs: 3,
      error: 'Line 2: Expected newline',
    });
    const body = await (await POST(request())).json();
    expect(body.error).toBe('Line 2: Expected newline');
  });

  it('输入缺字段：400 + missing_input_field + 字段路径，文案由 cloud 生成', async () => {
    mockEvaluateSource.mockRejectedValue(new PolicyApiError(
      "Input is missing field 'applicant.creditScore' that the policy reads.", 400, 'missing_input_field', undefined,
      { code: 'missing_input_field', field: 'applicant.creditScore', error: 'x' },
    ));
    const res = await POST(request());
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.code).toBe('missing_input_field');
    expect(body.field).toBe('applicant.creditScore');
    expect(body.error).toContain('applicant.creditScore');
  });
});
