/**
 * 测试辅助：构造 AI 工作台以服务签名代表用户调用 /api/llm/* 的请求（ADR 0049 §2.2）。
 * 签名规则与 src/lib/llm-caller.ts 的 canonicalAiWorkspace 一致，独立实现以便交叉校验。
 */
export const TEST_AI_WORKSPACE_KEY = 'k'.repeat(64);

async function hex(buf: ArrayBuffer): Promise<string> {
  return Buffer.from(buf).toString('hex');
}

/** 生成带全套服务签名头的 POST 请求；`over` 覆盖任意头以构造篡改场景。 */
export async function signedWorkspaceRequest(
  url: string,
  body: string,
  opts: { userId?: string; key?: string; over?: Record<string, string> } = {},
): Promise<Request> {
  const userId = opts.userId ?? 'u1';
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const enc = new TextEncoder();
  const bodySha = await hex(await crypto.subtle.digest('SHA-256', enc.encode(body)));
  const canonical = ['POST', new URL(url).pathname, ts, nonce, bodySha, userId].join('\n');
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(opts.key ?? TEST_AI_WORKSPACE_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await hex(await crypto.subtle.sign('HMAC', key, enc.encode(canonical)));
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Internal-Caller': 'ai-workspace',
    'X-Aster-Timestamp': ts,
    'X-Aster-Nonce': nonce,
    'X-Aster-User-Id': userId,
    'X-Internal-Signature': signature,
    ...opts.over,
  };
  return new Request(url, { method: 'POST', headers, body });
}
