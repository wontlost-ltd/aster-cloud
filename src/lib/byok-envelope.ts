/**
 * BYOK 推理接入（Phase 2）：为一次 AI 请求解析用户的 BYOK 凭证，构造转发给 aster-api 的
 * `_byok` envelope。
 *
 * 设计（Codex 审查）：
 *   - 只在服务端（cloud BFF）解密 BYOK key；浏览器 body 里的任何 `_byok` 一律不可信、被覆盖。
 *   - envelope 带 { provider, apiKey, baseUrl?, model? }。**baseUrl 可选**：用户配置了自定义 Provider URL
 *     才注入；aster-api **每次重新校验**（管理员 allowlist + SsrfGuard，防 SSRF），不信 cloud 传入值。
 *     baseUrl 为空则 aster-api 走官方硬编码端点（零行为变化）。cloud 侧不做 SSRF 判定（权威边界在
 *     真正发出站请求的 aster-api）。
 *   - 仅支持 openai / anthropic（Vertex 非简单 API-key 模型，Phase 2 排除）。
 *   - 注入 envelope 必须在 body 里，且调用方必须在注入【之后】再签名（HMAC 覆盖含 envelope 的
 *     最终 body），否则 aster-api 验签失败（fail-closed）。
 */
import {
  getBYOKCandidatesForInference,
  getDecryptedBYOKKeyById,
} from '@/lib/ai-key-vault';
import { byokTokensUsedThisMonth } from '@/lib/ai-quota';
import { isByokKeyExpired } from '@/lib/byok-expiry';

/** Phase 2 支持的 BYOK provider（与 aster-api LlmRuntimeOptionsResolver allowlist 一致）。 */
const SUPPORTED_BYOK_PROVIDERS = new Set(['openai', 'anthropic']);

export interface ByokEnvelope {
  provider: string;
  apiKey: string;
  /**
   * 用户配置的自定义 Provider URL（AiKeyBinding.providerUrl）。可选：为空则 aster-api 用官方
   * 硬编码端点。非空则注入转发 body 顶层 `_byok.baseUrl`，由 **aster-api 每次重新校验**（管理员
   * allowlist + SsrfGuard，不信 cloud 传入值）。cloud 侧不做 SSRF 判定（存 key 时已校验 https）。
   */
  baseUrl: string | null;
  /** AiKeyBinding.id —— 用于 Phase 3 精确 stamp lastUsedAt / usage 归类。不注入转发 body。 */
  bindingId: string;
  /** AiKeyBinding.model：用户为该 key 指定的模型；null=平台该 provider 默认。非空则注入 `_byok.model`。 */
  model: string | null;
}

/**
 * 解析用户当前可用的 BYOK envelope（多 key 优先级 fallback）。
 *
 * ★provider 选择语义（用户拍板）：LLM 推理请求**不带 provider**——由本函数按优先级挑一个
 * BYOK key，选中 key 的 provider 即本次请求用的 provider。用户明确选择「**全局跨 provider
 * 按优先级混排**」：所有 provider 的 key 排在同一优先级队列里，priority 最小者胜出（跨
 * openai/anthropic 混排）。UI 支持组内 ↑↓ 调序；跨 provider 的相对顺序由 (priority, createdAt)
 * 决定（save 时各 provider 组各自从 0 起 MAX+1，故不同 provider 可同 priority，createdAt 兜底
 * 稳定排序）。这是刻意的全局语义，非 bug。
 *
 * 选择策略（selection-time fallback，不做运行时重试）：
 *   1. 取该用户所有 active key，按 priority asc（同 priority 用 createdAt asc）排序。
 *   2. 顺次跳过：provider 不支持（vertex 等）、已过期（expiresAt<=now）、已超本月额度
 *      （tokenQuota!=null 且 已用>=tokenQuota）。选第一个通过的。
 *   3. 只解密胜出的那一个 key（未选中的不解密，减少密钥暴露面）。
 * 全部候选都不可用 → null（回退平台配额路径）。
 *
 * ⚠️ 额度口径：byokTokensUsedThisMonth 是**每用户跨所有 BYOK key 的聚合**（aiUsageRecords 无
 * binding 列），故这里的「超额跳过」是按用户总量、非严格 per-key。多 key 精确 per-key 计量需
 * usage 加 binding 列，属后续项；当前口径下：任一 key 设了 quota，一旦用户 BYOK 总用量达到它，
 * 该 key 即被跳过（保守，不会超用）。
 *
 * 解密【抛异常】（密钥系统/配置故障）→ 原样抛出，由路由 fail-closed 返回 503，而不是静默回退
 * 平台 key（否则 BYOK 用户会在密钥系统故障时偷偷消耗平台预算，Codex 审查）。
 */
export async function resolveByokEnvelope(userId: string): Promise<ByokEnvelope | null> {
  const candidates = await getBYOKCandidatesForInference(userId);
  if (candidates.length === 0) return null;

  const now = Date.now();
  // 仅当有候选设了 quota 时才查用量（省一次聚合查询）。
  const anyQuota = candidates.some((c) => c.tokenQuota != null);
  const usedThisMonth = anyQuota ? await byokTokensUsedThisMonth(userId) : 0;

  for (const c of candidates) {
    const provider = c.provider.trim().toLowerCase();
    // provider 不支持（vertex 非简单 API-key 模型，Phase 2 排除）→ 跳过看下一个。
    if (!SUPPORTED_BYOK_PROVIDERS.has(provider)) continue;
    // 已过期 → 跳过。
    if (isByokKeyExpired(c.expiresAt, now)) continue;
    // 已超本月额度 → 跳过（口径见上）。
    if (c.tokenQuota != null && usedThisMonth >= c.tokenQuota) continue;

    // 命中：只解密这一个。解密失败=密钥系统/配置故障 → 抛错（fail-closed 503）；解密返回空
    // （行刚被删/停用的竞态）→ 视作该候选不可用，继续看下一个。
    const apiKey = await getDecryptedBYOKKeyById(userId, c.id);
    if (!apiKey) continue;

    return { provider, apiKey, baseUrl: c.providerUrl ?? null, bindingId: c.id, model: c.model ?? null };
  }
  return null;
}

/**
 * 把服务端 envelope 注入请求 body 顶层：`_byok`（BYOK 凭证）+ `_usage`（issue #185 的
 * requestId，供 aster-api 回填真实 token 关联同一笔 usage）。先移除 caller 传入的任何 `_byok`/
 * `_usage`（防浏览器伪造），再写入服务端值。返回 { body, injected }：body 是最终字符串（供签名 +
 * 转发共用同一份），injected 表示是否真的注入了 BYOK envelope——调用方据此决定配额/记账（权威
 * usedByok），避免 body 非 JSON 导致"以为注入了实际没注入"的偏差（Codex 审查）。
 *
 * @param rawBody 原始请求 body 文本
 * @param envelope 服务端解析的 BYOK 凭证；null 则只剥离 caller 的 `_byok` 不注入
 * @param requestId issue #185 的请求关联 id；非空则注入 `_usage.requestId`
 */
export function injectByokEnvelope(
  rawBody: string,
  envelope: ByokEnvelope | null,
  requestId?: string | null
): { body: string; injected: boolean } {
  let parsed: Record<string, unknown>;
  try {
    parsed = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
  } catch {
    // body 非 JSON：无法注入（aster-api 也解析不了 envelope），原样返回、injected=false
    return { body: rawBody, injected: false };
  }
  // 红队：无论如何先删掉 caller 提交的 _byok / _usage（浏览器不可自带这些内部 envelope）
  delete parsed._byok;
  delete parsed._usage;
  const injected = envelope != null;
  if (envelope) {
    // baseUrl 仅在用户配置了自定义 Provider URL 时注入；aster-api 会重新校验（allowlist+SSRF）。
    // 为空则不加 baseUrl 字段，aster-api 走官方硬编码端点（零行为变化）。
    const byok: Record<string, string> = { provider: envelope.provider, apiKey: envelope.apiKey };
    if (envelope.baseUrl) {
      byok.baseUrl = envelope.baseUrl;
    }
    // model 仅在用户指定时注入；为空则 aster-api 用平台该 provider 默认（旧版 api 也能照常解析）。
    if (envelope.model) {
      byok.model = envelope.model;
    }
    parsed._byok = byok;
  }
  if (requestId) {
    parsed._usage = { requestId };
  }
  return { body: JSON.stringify(parsed), injected };
}
