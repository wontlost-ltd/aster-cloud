/**
 * 经 aster-api `POST /api/v1/ai/models` 查询某 BYOK 凭证可用的模型列表（ADR 0048 §3.3/§3.4）。
 *
 * 为什么不直接从 cloud 调 provider：出站 SSRF/allowlist 边界在 aster-api（自定义 providerUrl 必须
 * 经管理员 allowlist），cloud 只负责解密 key 并签名转发。结果只用于保存时校验与 UI 提示，
 * 不参与调用选择。
 */
import { signInternalCallerHeaders } from '@/lib/api-signing';

const ASTER_API_BASE =
  process.env.ASTER_POLICY_API_INTERNAL_URL ||
  process.env.NEXT_PUBLIC_ASTER_POLICY_API_URL ||
  'https://policy.aster-lang.dev';

const MODELS_PATH = '/api/v1/ai/models';

/** 与 aster-api ByokEnvelopeParser.normalizeModel 同一形状。 */
export const MODEL_ID_RE = /^[A-Za-z0-9._:/-]{1,128}$/;

/** models === null：网关不提供列表（不算错误，保存时跳过存在性校验）。 */
export type ByokModelsResult =
  | { ok: true; models: string[] | null; defaultModel: string }
  | { ok: false; error: string; rejection?: ProviderKeyRejection };

/**
 * provider 明确拒绝了这把 key 本身（aster-api 对 /models 回 422 provider_key_rejected）：
 * 如 401/403 鉴权失败，或 Anthropic key 未绑定 workspace 的 400。这与「暂时查不到列表」不同——
 * 重试没用，保存了也调不通，所以保存时必须拒绝并把 provider 的原话带给用户。
 */
export interface ProviderKeyRejection {
  /** provider_auth_failed | provider_bad_request（保持字符串以便前向兼容新增原因）。 */
  reason: string;
  /** aster-api 已脱敏并截断的 provider 原话；旧版/缺省为 null。 */
  message: string | null;
  providerErrorType: string | null;
}

const REJECTION_MESSAGE_MAX = 300;

function optString(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

/** 解析 422 provider_key_rejected 响应体；形状不符返回 null（调用方按普通失败处理）。 */
export function parseKeyRejection(body: unknown): ProviderKeyRejection | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.error !== 'provider_key_rejected') return null;
  return {
    reason: optString(b.reason, 64) ?? 'provider_bad_request',
    message: optString(b.message, REJECTION_MESSAGE_MAX),
    providerErrorType: optString(b.providerErrorType, 64),
  };
}

/**
 * 「模型列表未能校验」的稳定原因码，供 UI 解释为什么没校验成（只做提示，不阻断保存）。
 * aster-api 的 502 models_unavailable 已把 provider 401/403/5xx/连接失败合并、且不回传上游状态码，
 * 所以 cloud 只能区分到 provider_unavailable 这一层，不臆造更细的原因。
 */
export type UnverifiedReason =
  | 'cloud_misconfigured'
  | 'provider_unavailable'
  | 'endpoint_rejected'
  | 'timeout'
  | 'unknown';

const REASON_BY_ERROR: Record<string, UnverifiedReason> = {
  cloud_misconfigured: 'cloud_misconfigured',
  models_unavailable: 'provider_unavailable',
  invalid_byok: 'endpoint_rejected',
  timeout: 'timeout',
};

/** 把 fetchByokModels 的 error 映射成 UnverifiedReason；不认识的一律 unknown。 */
export function unverifiedReason(error: string): UnverifiedReason {
  return REASON_BY_ERROR[error] ?? 'unknown';
}

/**
 * AbortSignal.timeout 触发时 fetch 以 DOMException TimeoutError（部分运行时为 AbortError）拒绝。
 * DOMException 跨 realm 时不一定 instanceof Error，故按 name 结构判断。
 */
function isTimeout(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

export async function fetchByokModels(
  userId: string,
  creds: { provider: string; apiKey: string; baseUrl: string | null },
  opts?: { timeoutMs?: number },
): Promise<ByokModelsResult> {
  const byok: Record<string, string> = { provider: creds.provider, apiKey: creds.apiKey };
  if (creds.baseUrl) byok.baseUrl = creds.baseUrl;
  const body = JSON.stringify({ _byok: byok });

  let headers: Awaited<ReturnType<typeof signInternalCallerHeaders>>;
  try {
    // tenant 与推理路径一致：用户 id（见 llm/complete）。签名覆盖含 envelope 的最终 body。
    headers = await signInternalCallerHeaders('POST', MODELS_PATH, body, userId, '', { query: '', userId: '' });
  } catch {
    return { ok: false, error: 'cloud_misconfigured' };
  }

  try {
    const res = await fetch(`${ASTER_API_BASE}${MODELS_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': userId, ...headers },
      body,
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 10_000),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      // 422 仅在新版 aster-api 出现；旧版对同一场景回 502 models_unavailable，走下面的「未校验」旧路径。
      const rejection = res.status === 422 ? parseKeyRejection(err) : null;
      if (rejection) return { ok: false, error: 'provider_key_rejected', rejection };
      return { ok: false, error: err?.error ?? `http_${res.status}` };
    }
    const data = (await res.json()) as { models: string[] | null; defaultModel: string };
    return { ok: true, models: data.models ?? null, defaultModel: data.defaultModel };
  } catch (e) {
    if (isTimeout(e)) return { ok: false, error: 'timeout' };
    return { ok: false, error: e instanceof Error ? e.message : 'fetch_failed' };
  }
}
