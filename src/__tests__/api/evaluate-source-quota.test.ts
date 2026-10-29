// /api/policies/evaluate-source（会话执行任意 CNL 源码）的执行配额（Free 计划界面执行 hotfix，与 aster-api#411 同批）。
// aster-api 不再对 cloud 代登录会话的 HMAC 调用查 API 月度配额，本路由必须按执行用量自己限量：
// 修复前任何账号都可经此无上限执行（只有每用户每分钟 20 次的进程内限流）。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockEvaluateSource, mockCheckUsageLimit, mockRecordUsage, mockGetSession } = vi.hoisted(() => ({
  mockEvaluateSource: vi.fn(),
  mockCheckUsageLimit: vi.fn(),
  mockRecordUsage: vi.fn(),
  mockGetSession: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }));
vi.mock('@/lib/usage', () => ({ checkUsageLimit: mockCheckUsageLimit, recordUsage: mockRecordUsage }));
vi.mock('@/services/policy/policy-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/policy/policy-api')>();
  return { ...actual, createPolicyApiClient: vi.fn(() => ({ evaluateSource: mockEvaluateSource })) };
});

import { POST } from '@/app/api/policies/evaluate-source/route';
import { PolicyApiError } from '@/services/policy/policy-api';

let seq = 0;
function freshUser(): string {
  seq += 1;
  return `user-eval-src-${Date.now()}-${seq}`;
}

function request(): Request {
  return new Request('http://localhost/api/policies/evaluate-source', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'Module X.', context: { x: 1 } }),
  });
}

describe('POST /api/policies/evaluate-source — 执行配额', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordUsage.mockResolvedValue(undefined);
    mockCheckUsageLimit.mockResolvedValue({ allowed: true, limit: 1000, remaining: 1, used: 999 });
    mockEvaluateSource.mockResolvedValue({ result: true, executionTimeMs: 2, error: null });
  });

  it('Free 用户达到每月 1000 次执行后返回 429，不调用引擎', async () => {
    mockGetSession.mockResolvedValue({ user: { id: freshUser() } });
    mockCheckUsageLimit.mockResolvedValue({ allowed: false, limit: 1000, remaining: 0, used: 1000 });

    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.upgrade).toBe(true);
    expect(body.reason).toBe('evaluations');
    expect(body.limit).toBe(1000);
    expect(mockEvaluateSource).not.toHaveBeenCalled();
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('配额内执行成功按 execution 计量一次', async () => {
    const userId = freshUser();
    mockGetSession.mockResolvedValue({ user: { id: userId } });

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(mockCheckUsageLimit).toHaveBeenCalledWith(userId, 'execution');
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordUsage).toHaveBeenCalledWith(userId, 'execution');
  });

  it('引擎返回执行错误同样计量（引擎已运行）', async () => {
    mockGetSession.mockResolvedValue({ user: { id: freshUser() } });
    mockEvaluateSource.mockResolvedValue({ result: null, executionTimeMs: 2, error: 'Line 2: Expected newline' });

    const res = await POST(request());

    expect(res.status).toBe(400);
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
  });

  it('引擎调用失败（aster-api 拒绝）不计量', async () => {
    mockGetSession.mockResolvedValue({ user: { id: freshUser() } });
    mockEvaluateSource.mockRejectedValue(new PolicyApiError('boom', 503));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await POST(request());

    expect(res.status).toBe(503);
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('请求体不合法时既不查配额也不计量', async () => {
    mockGetSession.mockResolvedValue({ user: { id: freshUser() } });
    const res = await POST(new Request('http://localhost/api/policies/evaluate-source', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ context: {} }),
    }));

    expect(res.status).toBe(400);
    expect(mockCheckUsageLimit).not.toHaveBeenCalled();
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });
});
