import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * GDPR 导出路由（F24）：生产缺 AI_AUDIT_ENCRYPTION_SECRET 时返回 500 + 英文原文，且不记日志。
 * 现在返回结构化错误（带 requestId）并记 error 日志；查询失败（如密钥被轮换导致解密失败）同样处理。
 */
vi.mock('@/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1' } })) }));
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ db: { execute } }));

import { GET } from '@/app/api/user/ai-data-export/route';

const original = process.env.AI_AUDIT_ENCRYPTION_SECRET;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
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
});
