/**
 * cloud → AI 工作台的 GDPR 导出 / 抹除客户端（F23）。
 *
 * <p>「你的 AI 数据」页的下载与「清除内容」除了 cloud 自己的 AI 调用记录，还要覆盖工作台
 * 持久化的对话与审计。工作台暴露两个服务签名端点：`/internal/gdpr/export`、`/internal/gdpr/erase`。
 *
 * <p>签名与工作台 → cloud 方向（llm-caller.ts）同一 canonical 格式：
 * `[METHOD, path, ts(秒), nonce, sha256hex(body), userId]` 以换行拼接；密钥为独立的
 * `AI_WORKSPACE_GDPR_HMAC_KEY`（工作台侧 `AIW_GDPR_HMAC_KEY`），不得与 `AI_WORKSPACE_HMAC_KEY` 共用。
 * nonce 一次性：本客户端不重试，任何重试都必须重新签名。
 *
 * <p>配置语义：
 * <ul>
 *   <li>工作台地址未配置（dev / test 默认）→ `skipped`，调用方原样返回 cloud 数据；</li>
 *   <li>地址已配置但密钥缺失 → `error`（工作台在跑、可能存有数据，不能假装已覆盖），并记日志；</li>
 *   <li>请求失败 / 非 200 / 响应不合法 → `error`，日志只记原因码，绝不记 body、签名或用户 id。</li>
 * </ul>
 */
import { generateNonce, hmacSha256, sha256Hex } from '@/lib/api-signing';
import { canonicalAiWorkspace } from '@/lib/llm-caller';
import { resolveAiWorkspaceBase } from '@/lib/ai-workspace';
import { safeEnv } from '@/lib/runtime/safe-env';

/** 签名路径必须与契约逐字一致：无 query、无结尾斜杠。 */
export const AI_WORKSPACE_GDPR_PATHS = {
  export: '/internal/gdpr/export',
  erase: '/internal/gdpr/erase',
} as const;

export type AiWorkspaceGdprOp = keyof typeof AI_WORKSPACE_GDPR_PATHS;

/** cloud 作为调用方时的 `X-Internal-Caller` 取值（工作台按此精确匹配）。 */
const CLOUD_CALLER = 'aster-cloud';
/** 单次请求超时；导出不分页，给足时间但不让页面无限等待。 */
const TIMEOUT_MS = 15_000;

/** 工作台抹除结果（契约 `200 erase`）。 */
export type AiWorkspaceEraseResult = {
  deletedConversations: number;
  deletedAudit: number;
  tenantHold: boolean;
  held: string[];
};

export type AiWorkspaceGdprOutcome<T> =
  | { status: 'skipped' }
  | { status: 'ok'; data: T }
  | { status: 'error'; reason: string };

/** 构造签名请求头；时间戳与 nonce 由参数给出，便于用契约示例向量钉住。 */
export async function signAiWorkspaceGdprRequest(parts: {
  key: string;
  path: string;
  body: string;
  userId: string;
  timestamp: string;
  nonce: string;
}): Promise<Record<string, string>> {
  const bodySha = await sha256Hex(new TextEncoder().encode(parts.body).buffer as ArrayBuffer);
  const canonical = canonicalAiWorkspace('POST', parts.path, parts.timestamp, parts.nonce, bodySha, parts.userId);
  return {
    'Content-Type': 'application/json',
    'X-Internal-Caller': CLOUD_CALLER,
    'X-Aster-Timestamp': parts.timestamp,
    'X-Aster-Nonce': parts.nonce,
    'X-Aster-User-Id': parts.userId,
    'X-Internal-Signature': await hmacSha256(parts.key, canonical),
  };
}

/** 导出：返回工作台为该用户存储的全部数据（原样透传给用户下载）。 */
export function exportAiWorkspaceData(userId: string): Promise<AiWorkspaceGdprOutcome<Record<string, unknown>>> {
  return callAiWorkspaceGdpr('export', userId, (json) => json);
}

/** 抹除：删除该用户在工作台的对话与审计，法律保留（held / tenantHold）的线程除外。 */
export function eraseAiWorkspaceData(userId: string): Promise<AiWorkspaceGdprOutcome<AiWorkspaceEraseResult>> {
  return callAiWorkspaceGdpr('erase', userId, parseEraseResult);
}

function parseEraseResult(json: Record<string, unknown>): AiWorkspaceEraseResult | null {
  const held = json.held;
  if (!Array.isArray(held) || !held.every((h) => typeof h === 'string')) return null;
  return {
    deletedConversations: typeof json.deletedConversations === 'number' ? json.deletedConversations : 0,
    deletedAudit: typeof json.deletedAudit === 'number' ? json.deletedAudit : 0,
    tenantHold: json.tenantHold === true,
    held: held as string[],
  };
}

async function callAiWorkspaceGdpr<T>(
  op: AiWorkspaceGdprOp,
  userId: string,
  parse: (json: Record<string, unknown>) => T | null,
): Promise<AiWorkspaceGdprOutcome<T>> {
  const base = resolveAiWorkspaceBase(safeEnv('NEXT_PUBLIC_AI_WORKSPACE_URL'));
  if (!base) return { status: 'skipped' };
  const key = safeEnv('AI_WORKSPACE_GDPR_HMAC_KEY');
  if (!key) {
    console.error(`[ai-workspace-gdpr] ${op} unavailable: AI_WORKSPACE_GDPR_HMAC_KEY is not set`);
    return { status: 'error', reason: 'unconfigured' };
  }

  const path = AI_WORKSPACE_GDPR_PATHS[op];
  const requestId = `gdpr-${generateNonce().slice(0, 12)}`;
  // 只序列化一次：签名的字节与发送的字节必须完全相同。
  const body = JSON.stringify({ userId, requestId });
  const headers = await signAiWorkspaceGdprRequest({
    key,
    path,
    body,
    userId,
    timestamp: String(Math.floor(Date.now() / 1000)),
    nonce: generateNonce(),
  });

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.name : 'fetch_failed';
    console.warn(`[ai-workspace-gdpr] ${op} failed: reason=${reason} requestId=${requestId}`);
    return { status: 'error', reason: 'network' };
  }

  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const code = typeof json?.error === 'string' ? json.error : 'unknown';
    console.warn(`[ai-workspace-gdpr] ${op} rejected: status=${res.status} reason=${code} requestId=${requestId}`);
    return { status: 'error', reason: code };
  }
  const data = json !== null && typeof json === 'object' && !Array.isArray(json) ? parse(json) : null;
  if (data === null) {
    console.warn(`[ai-workspace-gdpr] ${op} failed: reason=bad_response requestId=${requestId}`);
    return { status: 'error', reason: 'bad_response' };
  }
  return { status: 'ok', data };
}
