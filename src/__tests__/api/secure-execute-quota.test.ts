// /api/v1/policies/[id]/secure-execute 的执行配额与限流（Free 计划界面执行 hotfix，与 aster-api#411 同批）。
// aster-api 不再对 cloud 代登录会话的 HMAC 调用查 API 月度配额，本路由必须自己按执行用量限量：
// 修复前任何登录用户（含 Free）都可经此无限次执行，绕过 Free 每月 1000 次执行。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecuteSecurely, mockCheckUsageLimit, mockRecordUsage } = vi.hoisted(() => ({
  mockExecuteSecurely: vi.fn(),
  mockCheckUsageLimit: vi.fn(),
  mockRecordUsage: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: vi.fn() }));
vi.mock('@/services/security/secure-executor', () => ({ executeSecurely: mockExecuteSecurely }));
vi.mock('@/lib/usage', () => ({ checkUsageLimit: mockCheckUsageLimit, recordUsage: mockRecordUsage }));
vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: vi.fn().mockRejectedValue(new Error('Not cloudflare')),
}));

import { POST } from '@/app/api/v1/policies/[id]/secure-execute/route';
import { auth } from '@/auth';

let seq = 0;
function freshUser(): string {
  seq += 1;
  return `user-secure-${Date.now()}-${seq}`;
}

function request(): Request {
  return new Request('http://localhost/api/v1/policies/p1/secure-execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hash: 'sha256:x', input: { x: 1 }, timestamp: Date.now(), nonce: 'n', signature: 's' }),
  });
}

const params = { params: Promise.resolve({ id: 'p1' }) };

async function call(userId: string) {
  vi.mocked(auth).mockResolvedValue({ user: { id: userId } } as never);
  return POST(request() as never, params);
}

describe('POST /api/v1/policies/[id]/secure-execute — 执行配额与限流', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordUsage.mockResolvedValue(undefined);
    mockCheckUsageLimit.mockResolvedValue({ allowed: true, limit: 1000, remaining: 10, used: 990 });
    mockExecuteSecurely.mockResolvedValue({ success: true, result: { ok: true }, executionTimeMs: 3, engineInvoked: true });
  });

  it('Free 用户达到每月 1000 次执行后返回 429，不再执行', async () => {
    mockCheckUsageLimit.mockResolvedValue({ allowed: false, limit: 1000, remaining: 0, used: 1000 });

    const res = await call(freshUser());
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.upgrade).toBe(true);
    expect(body.reason).toBe('evaluations');
    expect(body.limit).toBe(1000);
    expect(body.usage).toBe(1000);
    expect(mockExecuteSecurely).not.toHaveBeenCalled();
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('配额内执行一次即按 execution 计量一次', async () => {
    const userId = freshUser();
    const res = await call(userId);

    expect(res.status).toBe(200);
    expect(mockCheckUsageLimit).toHaveBeenCalledWith(userId, 'execution');
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordUsage).toHaveBeenCalledWith(userId, 'execution');
  });

  it('引擎返回执行错误同样计量（引擎已运行）', async () => {
    mockExecuteSecurely.mockResolvedValue({
      success: false, error: 'Line 2: Expected newline', executionTimeMs: 2, engineInvoked: true,
    });
    const res = await call(freshUser());

    expect(res.status).toBe(400);
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
  });

  it('引擎调用失败（aster-api 拒绝或不可达）不计量', async () => {
    mockExecuteSecurely.mockResolvedValue({
      success: false, error: '策略执行失败', errorCode: 'EXECUTION_FAILED', executionTimeMs: 2,
    });
    const res = await call(freshUser());

    expect(res.status).toBe(400);
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('执行前被拒（签名无效）不计量', async () => {
    mockExecuteSecurely.mockResolvedValue({ success: false, error: '请求签名无效', errorCode: 'SIGNATURE_INVALID' });
    const res = await call(freshUser());

    expect(res.status).toBe(401);
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('签名密钥未配置时 503，不计量', async () => {
    mockExecuteSecurely.mockResolvedValue({ success: false, error: '安全执行未配置签名密钥', errorCode: 'SIGNING_UNAVAILABLE' });
    const res = await call(freshUser());

    expect(res.status).toBe(503);
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('同一用户每分钟超过 30 次返回 429 rate_limited，不再查配额也不执行', async () => {
    const userId = freshUser();
    for (let i = 0; i < 30; i++) {
      expect((await call(userId)).status).toBe(200);
    }
    mockExecuteSecurely.mockClear();
    mockCheckUsageLimit.mockClear();

    const res = await call(userId);
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.code).toBe('rate_limited');
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(mockCheckUsageLimit).not.toHaveBeenCalled();
    expect(mockExecuteSecurely).not.toHaveBeenCalled();
  });
});
