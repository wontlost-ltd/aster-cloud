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
  | { ok: false; error: string };

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
      return { ok: false, error: err?.error ?? `http_${res.status}` };
    }
    const data = (await res.json()) as { models: string[] | null; defaultModel: string };
    return { ok: true, models: data.models ?? null, defaultModel: data.defaultModel };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'fetch_failed' };
  }
}
