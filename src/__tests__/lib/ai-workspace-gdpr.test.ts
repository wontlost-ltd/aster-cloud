// cloud → AI 工作台 GDPR 客户端（F23）。
//
// 钉住（契约第 2 版）：①契约示例向量（工作台 GdprControllerTest.contractExampleVector 钉同一值）
// ②工作台地址未配置 → skipped，不发请求 ③地址已配置但密钥缺失 / 不足 32 字节 / 与服务间密钥相同 → error，
// 不发请求 ④签名请求头 / body 与契约一致，且签的正是发送的原始字节 ⑤非 200（含 413）、网络失败、
// 响应不合法 → error，日志不含用户 id ⑥导出原样保留截断标记 ⑦抹除结果解析（held / tenantHold / invalidatedSessions）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn() }));
vi.mock('@/services/security/nonce-service', () => ({ claimNonce: vi.fn() }));

const KEY = 'gdpr-test-key-0123456789abcdef0123456789';
const USER = 'clx0user123';

async function hmacHex(key: string, data: string) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Buffer.from(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data))).toString('hex');
}
async function sha(s: string) {
  return Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))).toString('hex');
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let fetchMock: ReturnType<typeof vi.fn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('NEXT_PUBLIC_AI_WORKSPACE_URL', 'https://ai.aster-lang.cloud/');
  vi.stubEnv('AI_WORKSPACE_GDPR_HMAC_KEY', KEY);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('signAiWorkspaceGdprRequest', () => {
  it('★契约示例向量（第 2 版）：签名与工作台一致', async () => {
    const { signAiWorkspaceGdprRequest } = await import('@/lib/ai-workspace-gdpr');
    const body = '{"userId":"clx0user123","requestId":"gdpr-7f3a"}';
    expect(await sha(body)).toBe('08355f4628d41ab94fd56a21be83849805253a2a05f5a52f8c1f59b419260751');
    const headers = await signAiWorkspaceGdprRequest({
      key: 'example-key-do-not-use-0123456789abcdef',
      path: '/internal/gdpr/export',
      body: new TextEncoder().encode(body),
      userId: 'clx0user123',
      timestamp: '1792670000',
      nonce: '0123456789abcdef0123456789abcdef',
    });
    expect(headers).toEqual({
      'Content-Type': 'application/json',
      'X-Internal-Caller': 'aster-cloud',
      'X-Aster-Timestamp': '1792670000',
      'X-Aster-Nonce': '0123456789abcdef0123456789abcdef',
      'X-Aster-User-Id': 'clx0user123',
      'X-Internal-Signature': 'b4554bc2da70c9ad39ab93d9eb4167e729b808822f97ffc56f01b930946b0f5f',
    });
  });

  it('签名覆盖字节视图本身（子数组不会混入底层缓冲区的其余字节）', async () => {
    const { signAiWorkspaceGdprRequest } = await import('@/lib/ai-workspace-gdpr');
    const body = '{"userId":"clx0user123","requestId":"gdpr-7f3a"}';
    const padded = new TextEncoder().encode(`xx${body}yy`).subarray(2, 2 + body.length);
    const parts = { key: 'example-key-do-not-use-0123456789abcdef', path: '/internal/gdpr/export', userId: 'clx0user123', timestamp: '1792670000', nonce: '0123456789abcdef0123456789abcdef' };
    expect((await signAiWorkspaceGdprRequest({ ...parts, body: padded }))['X-Internal-Signature'])
      .toBe('b4554bc2da70c9ad39ab93d9eb4167e729b808822f97ffc56f01b930946b0f5f');
  });
});

describe('resolveAiWorkspaceGdprKey', () => {
  it('去首尾空白；缺失 / 不足 32 字节 / 与服务间密钥相同 → 不可用', async () => {
    const { resolveAiWorkspaceGdprKey } = await import('@/lib/ai-workspace-gdpr');
    expect(resolveAiWorkspaceGdprKey(`  ${KEY}\n`, 'other')).toEqual({ key: KEY });
    expect(resolveAiWorkspaceGdprKey(undefined, 'other')).toEqual({ problem: 'missing' });
    expect(resolveAiWorkspaceGdprKey('   ', 'other')).toEqual({ problem: 'missing' });
    expect(resolveAiWorkspaceGdprKey('a'.repeat(31), 'other')).toEqual({ problem: 'too_short' });
    expect(resolveAiWorkspaceGdprKey('a'.repeat(32), 'other')).toEqual({ key: 'a'.repeat(32) });
    // 按 UTF-8 字节计：11 个三字节汉字 = 33 字节
    expect(resolveAiWorkspaceGdprKey('密'.repeat(11), 'other')).toEqual({ key: '密'.repeat(11) });
    expect(resolveAiWorkspaceGdprKey(KEY, ` ${KEY} `)).toEqual({ problem: 'reused' });
  });
});

describe('exportAiWorkspaceData', () => {
  it('工作台地址未配置 → skipped，不发请求', async () => {
    vi.stubEnv('NEXT_PUBLIC_AI_WORKSPACE_URL', '');
    const { exportAiWorkspaceData } = await import('@/lib/ai-workspace-gdpr');
    expect(await exportAiWorkspaceData(USER)).toEqual({ status: 'skipped' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('地址已配置但缺密钥 → error（不能假装已覆盖），不发请求并记日志', async () => {
    vi.stubEnv('AI_WORKSPACE_GDPR_HMAC_KEY', '');
    const { exportAiWorkspaceData } = await import('@/lib/ai-workspace-gdpr');
    expect(await exportAiWorkspaceData(USER)).toEqual({ status: 'error', reason: 'unconfigured' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it.each([
    ['过短', 'short-key', undefined],
    ['与服务间 HMAC 密钥相同', KEY, KEY],
  ])('密钥%s → error（视同未配置），不发请求并记日志', async (_label, gdprKey, serviceKey) => {
    vi.stubEnv('AI_WORKSPACE_GDPR_HMAC_KEY', gdprKey);
    if (serviceKey) vi.stubEnv('AI_WORKSPACE_HMAC_KEY', serviceKey);
    const { exportAiWorkspaceData } = await import('@/lib/ai-workspace-gdpr');
    expect(await exportAiWorkspaceData(USER)).toEqual({ status: 'error', reason: 'unconfigured' });
    expect(fetchMock).not.toHaveBeenCalled();
    const logged = errorSpy.mock.calls.flat().join(' ');
    expect(logged).toContain('AI_WORKSPACE_GDPR_HMAC_KEY');
    expect(logged).not.toContain(gdprKey);
  });

  it('★签名请求：路径、请求头、body 与契约一致，签的正是发送的字节', async () => {
    const payload = { userId: USER, persisted: true, conversations: [], audit: [] };
    fetchMock.mockResolvedValue(jsonResponse(payload));
    const { exportAiWorkspaceData } = await import('@/lib/ai-workspace-gdpr');
    expect(await exportAiWorkspaceData(USER)).toEqual({ status: 'ok', data: payload });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ai.aster-lang.cloud/internal/gdpr/export');
    expect(init.method).toBe('POST');
    const h = init.headers as Record<string, string>;
    // 发送的是一次编码好的 UTF-8 字节，签名覆盖的正是这些字节
    expect(ArrayBuffer.isView(init.body)).toBe(true);
    const sent = init.body as Uint8Array;
    const body = new TextDecoder().decode(sent);
    expect(sent.byteLength).toBeLessThanOrEqual(4096);
    expect(JSON.parse(body)).toMatchObject({ userId: USER });
    expect(h['X-Internal-Caller']).toBe('aster-cloud');
    expect(h['X-Aster-User-Id']).toBe(USER);
    expect(h['X-Aster-Nonce']).toMatch(/^[0-9a-f]{32}$/);
    expect(h['X-Aster-Timestamp']).toMatch(/^\d{1,12}$/);
    expect(Math.abs(Number(h['X-Aster-Timestamp']) - Date.now() / 1000)).toBeLessThan(5);
    const canonical = ['POST', '/internal/gdpr/export', h['X-Aster-Timestamp'], h['X-Aster-Nonce'], Buffer.from(await crypto.subtle.digest('SHA-256', Uint8Array.from(sent))).toString('hex'), USER].join('\n');
    expect(h['X-Internal-Signature']).toBe(await hmacHex(KEY, canonical));
  });

  it('每次请求使用新 nonce', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ conversations: [] }));
    const { exportAiWorkspaceData } = await import('@/lib/ai-workspace-gdpr');
    await exportAiWorkspaceData(USER);
    await exportAiWorkspaceData(USER);
    const nonces = fetchMock.mock.calls.map((c) => (c[1] as RequestInit & { headers: Record<string, string> }).headers['X-Aster-Nonce']);
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it('★非 200 → error（原因码来自响应），日志不含用户 id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'bad_signature' }, 401));
    const { exportAiWorkspaceData } = await import('@/lib/ai-workspace-gdpr');
    expect(await exportAiWorkspaceData(USER)).toEqual({ status: 'error', reason: 'bad_signature' });
    const logged = warnSpy.mock.calls.flat().join(' ');
    expect(logged).toContain('bad_signature');
    expect(logged).not.toContain(USER);
  });

  it('413 body_too_large → error，原因码原样记录', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'body_too_large' }, 413));
    const { exportAiWorkspaceData } = await import('@/lib/ai-workspace-gdpr');
    expect(await exportAiWorkspaceData(USER)).toEqual({ status: 'error', reason: 'body_too_large' });
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('status=413');
  });

  it('userId 过长使 body 超过 4096 字节 → 本地拒绝，不发请求', async () => {
    const { exportAiWorkspaceData } = await import('@/lib/ai-workspace-gdpr');
    expect(await exportAiWorkspaceData('u'.repeat(5000))).toEqual({ status: 'error', reason: 'body_too_large' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('★导出达到上限：截断标记原样保留在导出 JSON 中', async () => {
    const payload = { userId: USER, persisted: true, conversations: [], conversationsTruncated: true, audit: [], auditTruncated: false };
    fetchMock.mockResolvedValue(jsonResponse(payload));
    const { exportAiWorkspaceData } = await import('@/lib/ai-workspace-gdpr');
    expect(await exportAiWorkspaceData(USER)).toEqual({ status: 'ok', data: payload });
  });

  it('网络失败 / 超时 → error', async () => {
    fetchMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    const { exportAiWorkspaceData } = await import('@/lib/ai-workspace-gdpr');
    expect(await exportAiWorkspaceData(USER)).toEqual({ status: 'error', reason: 'network' });
  });

  it('响应不是 JSON 对象 → error', async () => {
    fetchMock.mockResolvedValue(new Response('<html>', { status: 200 }));
    const { exportAiWorkspaceData } = await import('@/lib/ai-workspace-gdpr');
    expect(await exportAiWorkspaceData(USER)).toEqual({ status: 'error', reason: 'bad_response' });
  });
});

describe('eraseAiWorkspaceData', () => {
  it('调用 erase 路径并解析 held / tenantHold / invalidatedSessions', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        userId: USER, persisted: true, deletedConversations: 3, deletedAudit: 41, tenantHold: false,
        held: ['policy:p-9'], invalidatedSessions: 1,
      }),
    );
    const { eraseAiWorkspaceData } = await import('@/lib/ai-workspace-gdpr');
    expect(await eraseAiWorkspaceData(USER)).toEqual({
      status: 'ok',
      data: { deletedConversations: 3, deletedAudit: 41, tenantHold: false, held: ['policy:p-9'], invalidatedSessions: 1 },
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://ai.aster-lang.cloud/internal/gdpr/erase');
  });

  it('缺少 held 数组 → error（无法确认保留情况）', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ deletedConversations: 1 }));
    const { eraseAiWorkspaceData } = await import('@/lib/ai-workspace-gdpr');
    expect(await eraseAiWorkspaceData(USER)).toEqual({ status: 'error', reason: 'bad_response' });
  });
});
