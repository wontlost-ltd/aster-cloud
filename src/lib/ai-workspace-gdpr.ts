/**
 * cloud → AI 工作台的 GDPR 导出 / 抹除客户端（F23）。
 *
 * <p>「你的 AI 数据」页的下载与「清除内容」除了 cloud 自己的 AI 调用记录，还要覆盖工作台
 * 持久化的对话与审计。工作台暴露两个服务签名端点：`/internal/gdpr/export`、`/internal/gdpr/erase`。
 *
 * <p>契约见 f23-contract 第 2 版。签名与工作台 → cloud 方向（llm-caller.ts）同一 canonical 格式：
 * `[METHOD, path, ts(秒), nonce, sha256hex(原始 body 字节), userId]` 以换行拼接。body 只编码一次为
 * UTF-8 字节，签名与发送用同一份字节；body 上限 4096 字节（超出工作台返回 413）。
 * 密钥为独立的 `AI_WORKSPACE_GDPR_HMAC_KEY`（工作台侧 `AIW_GDPR_HMAC_KEY`），去掉首尾空白后
 * 至少 32 字节，且不得与 `AI_WORKSPACE_HMAC_KEY` 相同。
 * nonce 一次性：本客户端不重试，任何重试都必须重新签名。
 *
 * <p>配置语义：
 * <ul>
 *   <li>工作台地址未配置（dev / test 默认）→ `skipped`，调用方原样返回 cloud 数据；</li>
 *   <li>地址已配置但密钥缺失、过短或与服务间 HMAC 密钥相同 → `error`（工作台在跑、可能存有数据，
 *     不能假装已覆盖），并记日志；工作台对这类密钥同样拒绝（503 gdpr_unconfigured）；</li>
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
/** 契约：请求 body 最多 4096 字节。 */
export const AI_WORKSPACE_GDPR_MAX_BODY_BYTES = 4096;
/** 契约：密钥（去首尾空白后）至少 32 字节 UTF-8。 */
export const AI_WORKSPACE_GDPR_MIN_KEY_BYTES = 32;

/** 工作台抹除结果（契约 `200 erase`）。 */
export type AiWorkspaceEraseResult = {
  deletedConversations: number;
  deletedAudit: number;
  tenantHold: boolean;
  held: string[];
  /** 抹除后在工作台失效的会话数（已打开的标签页需重新经 cloud 交接）。 */
  invalidatedSessions: number;
};

/**
 * 读取可用的 GDPR 签名密钥：与工作台同样去掉首尾空白；缺失、不足 32 字节或与服务间
 * HMAC 密钥相同都视为未配置，返回不可用原因（只用于日志，不含密钥本身）。
 */
export function resolveAiWorkspaceGdprKey(
  raw: string | undefined,
  serviceKey: string | undefined,
): { key: string } | { problem: 'missing' | 'too_short' | 'reused' } {
  const key = (raw ?? '').trim();
  if (!key) return { problem: 'missing' };
  if (new TextEncoder().encode(key).length < AI_WORKSPACE_GDPR_MIN_KEY_BYTES) return { problem: 'too_short' };
  if (key === (serviceKey ?? '').trim()) return { problem: 'reused' };
  return { key };
}

export type AiWorkspaceGdprOutcome<T> =
  | { status: 'skipped' }
  | { status: 'ok'; data: T }
  | { status: 'error'; reason: string };

/**
 * 构造签名请求头；时间戳与 nonce 由参数给出，便于用契约示例向量钉住。
 * `body` 是将要原样发送的字节，签名覆盖的正是这些字节。
 */
export async function signAiWorkspaceGdprRequest(parts: {
  key: string;
  path: string;
  body: Uint8Array;
  userId: string;
  timestamp: string;
  nonce: string;
}): Promise<Record<string, string>> {
  const bytes = parts.body;
  const bodySha = await sha256Hex(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
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

/**
 * 导出：返回工作台为该用户存储的全部数据，原样透传给用户下载——包括
 * `conversationsTruncated` / `auditTruncated`（达到上限、导出不完整时为 true）。
 */
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
    invalidatedSessions: typeof json.invalidatedSessions === 'number' ? json.invalidatedSessions : 0,
  };
}

async function callAiWorkspaceGdpr<T>(
  op: AiWorkspaceGdprOp,
  userId: string,
  parse: (json: Record<string, unknown>) => T | null,
): Promise<AiWorkspaceGdprOutcome<T>> {
  const base = resolveAiWorkspaceBase(safeEnv('NEXT_PUBLIC_AI_WORKSPACE_URL'));
  if (!base) return { status: 'skipped' };
  const resolved = resolveAiWorkspaceGdprKey(safeEnv('AI_WORKSPACE_GDPR_HMAC_KEY'), safeEnv('AI_WORKSPACE_HMAC_KEY'));
  if ('problem' in resolved) {
    console.error(
      `[ai-workspace-gdpr] ${op} unavailable: AI_WORKSPACE_GDPR_HMAC_KEY is ${resolved.problem} ` +
        `(needs >= ${AI_WORKSPACE_GDPR_MIN_KEY_BYTES} bytes and must differ from AI_WORKSPACE_HMAC_KEY)`,
    );
    return { status: 'error', reason: 'unconfigured' };
  }

  const path = AI_WORKSPACE_GDPR_PATHS[op];
  const requestId = `gdpr-${generateNonce().slice(0, 12)}`;
  // 只编码一次：签名的字节与发送的字节必须完全相同。
  const body = new TextEncoder().encode(JSON.stringify({ userId, requestId }));
  if (body.byteLength > AI_WORKSPACE_GDPR_MAX_BODY_BYTES) {
    console.warn(`[ai-workspace-gdpr] ${op} failed: reason=body_too_large requestId=${requestId}`);
    return { status: 'error', reason: 'body_too_large' };
  }
  const headers = await signAiWorkspaceGdprRequest({
    key: resolved.key,
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
