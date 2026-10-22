import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * GDPR 抹除路由（F23）：cloud 自身清除后，再抹除 AI 工作台存储的对话与审计。
 * 工作台未部署时不调用；失败时 cloud 部分照常生效并标记 unavailable；法律保留原样回给界面。
 */
vi.mock('@/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1' } })) }));
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ db: { execute } }));
vi.mock('@/services/security/nonce-service', () => ({ claimNonce: vi.fn() }));

import { DELETE } from '@/app/api/user/ai-data/route';

let warnSpy: ReturnType<typeof vi.spyOn>;
let fetchMock: ReturnType<typeof vi.fn>;

function workspaceConfigured() {
  vi.stubEnv('NEXT_PUBLIC_AI_WORKSPACE_URL', 'https://ai.aster-lang.cloud');
  vi.stubEnv('AI_WORKSPACE_GDPR_HMAC_KEY', 'gdpr-test-key');
}

beforeEach(() => {
  vi.clearAllMocks();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubEnv('NEXT_PUBLIC_AI_WORKSPACE_URL', '');
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  execute.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);
});
afterEach(() => {
  warnSpy.mockRestore();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('DELETE /api/user/ai-data', () => {
  it('工作台未部署 → 只清除 cloud，不调用工作台，响应中没有 aiWorkspace', async () => {
    const body = await (await DELETE()).json();
    expect(body.records_cleared).toBe(2);
    expect(body).not.toHaveProperty('aiWorkspace');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('★先清除 cloud，再调用工作台 erase；held 原样返回', async () => {
    workspaceConfigured();
    const order: string[] = [];
    execute.mockImplementationOnce(async () => {
      order.push('cloud');
      return [{ id: 'r1' }];
    });
    fetchMock.mockImplementation(async () => {
      order.push('workspace');
      return new Response(
        JSON.stringify({ userId: 'u1', persisted: true, deletedConversations: 3, deletedAudit: 41, tenantHold: false, held: ['policy:p-9'] }),
        { status: 200 },
      );
    });
    const res = await DELETE();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(order).toEqual(['cloud', 'workspace']);
    expect(fetchMock.mock.calls[0][0]).toBe('https://ai.aster-lang.cloud/internal/gdpr/erase');
    expect(body.aiWorkspace).toEqual({ deletedConversations: 3, deletedAudit: 41, tenantHold: false, held: ['policy:p-9'] });
  });

  it('用户级法律保留（tenantHold）原样返回', async () => {
    workspaceConfigured();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ deletedConversations: 0, deletedAudit: 0, tenantHold: true, held: ['a', 'b'] }), { status: 200 }),
    );
    const body = await (await DELETE()).json();
    expect(body.aiWorkspace).toMatchObject({ tenantHold: true, held: ['a', 'b'] });
  });

  it('★工作台失败 → cloud 清除照常生效，aiWorkspace 为 unavailable', async () => {
    workspaceConfigured();
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const res = await DELETE();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.records_cleared).toBe(2);
    expect(body.aiWorkspace).toEqual({ error: 'unavailable' });
  });
});
