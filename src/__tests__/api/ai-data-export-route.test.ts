import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * GDPR 导出路由（F24 / review I2）：审计密钥缺失或解密失败时降级导出——非加密字段与工作台数据照常返回，
 * 原文部分标为 `auditContent: { error: 'unavailable' }` 并记 error 日志；连非加密查询都失败才返回 500。
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
  it('★密钥未配置 → 降级导出：非加密字段照常返回，auditContent 为 unavailable，并记 error 日志', async () => {
    delete process.env.AI_AUDIT_ENCRYPTION_SECRET;
    execute.mockResolvedValueOnce([{ id: 'r1', prompt: null, completion: null }]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ user_id: 'u1', record_count: 1, records: [{ id: 'r1' }] });
    expect(body.auditContent).toEqual({ error: 'unavailable' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      '[ai-data-export] AI_AUDIT_ENCRYPTION_SECRET is not configured',
      res.headers.get('x-request-id'),
    );
  });

  it('★解密失败（密钥被轮换）→ 改用不解密查询降级导出', async () => {
    process.env.AI_AUDIT_ENCRYPTION_SECRET = 'test-audit-secret-min-16-chars';
    execute
      .mockRejectedValueOnce(new Error('Wrong key or corrupt data'))
      .mockResolvedValueOnce([{ id: 'r1', prompt: null }]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.records).toEqual([{ id: 'r1', prompt: null }]);
    expect(body.auditContent).toEqual({ error: 'unavailable' });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('★降级时仍合并工作台数据（F23）', async () => {
    delete process.env.AI_AUDIT_ENCRYPTION_SECRET;
    vi.stubEnv('NEXT_PUBLIC_AI_WORKSPACE_URL', 'https://ai.aster-lang.cloud');
    vi.stubEnv('AI_WORKSPACE_GDPR_HMAC_KEY', 'gdpr-test-key-0123456789abcdef0123456789');
    execute.mockResolvedValueOnce([]);
    const payload = { userId: 'u1', persisted: true, conversations: [], audit: [] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })));
    const body = await (await GET()).json();
    expect(body.auditContent).toEqual({ error: 'unavailable' });
    expect(body.aiWorkspace).toEqual(payload);
  });

  it('非加密查询也失败 → 500 结构化错误并记日志', async () => {
    delete process.env.AI_AUDIT_ENCRYPTION_SECRET;
    execute.mockRejectedValueOnce(new Error('connection refused'));
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('audit_export_failed');
    expect(body.error.requestId).toBe(res.headers.get('x-request-id'));
    expect(errorSpy).toHaveBeenCalled();
  });

  it('★解密失败日志不含密钥与错误原文，只记 requestId 与错误码（I1）', async () => {
    const secret = 'test-audit-secret-min-16-chars';
    process.env.AI_AUDIT_ENCRYPTION_SECRET = secret;
    const err = new Error(`Failed query: SELECT ...\nparams: ${secret},u1`, {
      cause: Object.assign(new Error('Wrong key or corrupt data'), { code: '39000' }),
    });
    err.name = 'DrizzleQueryError';
    execute.mockRejectedValueOnce(err).mockResolvedValueOnce([]);
    const res = await GET();
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain('Failed query');
    expect(errorSpy.mock.calls[0]).toEqual([
      '[ai-data-export] audit decrypt failed',
      res.headers.get('x-request-id'),
      '39000',
    ]);
  });

  it('正常导出', async () => {
    process.env.AI_AUDIT_ENCRYPTION_SECRET = 'test-audit-secret-min-16-chars';
    execute.mockResolvedValueOnce([{ id: 'r1', prompt: 'p' }]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ user_id: 'u1', record_count: 1 });
    expect(body).not.toHaveProperty('auditContent');
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
    vi.stubEnv('AI_WORKSPACE_GDPR_HMAC_KEY', 'gdpr-test-key-0123456789abcdef0123456789');
    execute.mockResolvedValueOnce([{ id: 'r1' }]);
    const payload = {
      userId: 'u1',
      persisted: true,
      conversations: [{ threadId: 'policy:p-1', title: 't', messages: [] }],
      conversationsTruncated: false,
      audit: [],
      auditTruncated: true,
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
    vi.stubEnv('AI_WORKSPACE_GDPR_HMAC_KEY', 'gdpr-test-key-0123456789abcdef0123456789');
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
