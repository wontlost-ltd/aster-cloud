import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * GDPR 导出路由（F24）：生产缺 AI_AUDIT_ENCRYPTION_SECRET 时返回 500 + 英文原文，且不记日志。
 * 现在返回结构化错误（带 requestId）并记 error 日志；查询失败（如密钥被轮换导致解密失败）同样处理。
 */
vi.mock('@/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1' } })) }));
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ db: { execute } }));
// 工作台客户端依赖 llm-caller（canonical 拼接），后者引入 nonce 服务；本测试不走验签。
vi.mock('@/services/security/nonce-service', () => ({ claimNonce: vi.fn() }));

import { GET } from '@/app/api/user/ai-data-export/route';

const original = process.env.AI_AUDIT_ENCRYPTION_SECRET;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  // 默认工作台未部署（dev / test 默认），各用例按需开启。
  vi.stubEnv('NEXT_PUBLIC_AI_WORKSPACE_URL', '');
});
afterEach(() => {
  errorSpy.mockRestore();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (original === undefined) delete process.env.AI_AUDIT_ENCRYPTION_SECRET;
  else process.env.AI_AUDIT_ENCRYPTION_SECRET = original;
});

describe('GET /api/user/ai-data-export', () => {
  it('★密钥未配置 → 503 结构化错误 + requestId，并记 error 日志', async () => {
    delete process.env.AI_AUDIT_ENCRYPTION_SECRET;
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('audit_export_unavailable');
    expect(body.error.requestId).toBe(res.headers.get('x-request-id'));
    expect(errorSpy).toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('解密查询失败 → 500 结构化错误并记日志', async () => {
    process.env.AI_AUDIT_ENCRYPTION_SECRET = 'test-audit-secret-min-16-chars';
    execute.mockRejectedValueOnce(new Error('Wrong key or corrupt data'));
    const res = await GET();
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('audit_export_failed');
    expect(errorSpy).toHaveBeenCalled();
  });

  it('正常导出', async () => {
    process.env.AI_AUDIT_ENCRYPTION_SECRET = 'test-audit-secret-min-16-chars';
    execute.mockResolvedValueOnce([{ id: 'r1', prompt: 'p' }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user_id: 'u1', record_count: 1 });
  });

  it('工作台未部署 → 不调用工作台，响应中没有 aiWorkspace（F23）', async () => {
    process.env.AI_AUDIT_ENCRYPTION_SECRET = 'test-audit-secret-min-16-chars';
    execute.mockResolvedValueOnce([]);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const body = await (await GET()).json();
    expect(body).not.toHaveProperty('aiWorkspace');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('★工作台已部署 → 合并工作台导出到 aiWorkspace（F23）', async () => {
    process.env.AI_AUDIT_ENCRYPTION_SECRET = 'test-audit-secret-min-16-chars';
    vi.stubEnv('NEXT_PUBLIC_AI_WORKSPACE_URL', 'https://ai.aster-lang.cloud');
    vi.stubEnv('AI_WORKSPACE_GDPR_HMAC_KEY', 'gdpr-test-key');
    execute.mockResolvedValueOnce([{ id: 'r1' }]);
    const payload = {
      userId: 'u1',
      persisted: true,
      conversations: [{ threadId: 'policy:p-1', title: 't', messages: [] }],
      audit: [],
    };
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(payload), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ user_id: 'u1', record_count: 1, records: [{ id: 'r1' }] });
    expect(body.aiWorkspace).toEqual(payload);
    expect(fetchMock.mock.calls[0][0]).toBe('https://ai.aster-lang.cloud/internal/gdpr/export');
  });

  it('★工作台调用失败 → 仍返回 cloud 数据，aiWorkspace 为 unavailable（F23）', async () => {
    process.env.AI_AUDIT_ENCRYPTION_SECRET = 'test-audit-secret-min-16-chars';
    vi.stubEnv('NEXT_PUBLIC_AI_WORKSPACE_URL', 'https://ai.aster-lang.cloud');
    vi.stubEnv('AI_WORKSPACE_GDPR_HMAC_KEY', 'gdpr-test-key');
    execute.mockResolvedValueOnce([{ id: 'r1' }]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"storage_unavailable"}', { status: 503 })));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await GET();
    warn.mockRestore();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.records).toEqual([{ id: 'r1' }]);
    expect(body.aiWorkspace).toEqual({ error: 'unavailable' });
  });
});
