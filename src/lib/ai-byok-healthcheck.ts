// BYOK 健康检查：每天 ping 用户绑定的 key，连续 3 次失败自动停用
//
// 调用方：/api/cron/byok-healthcheck（每天 03:00 UTC）

import { db, aiKeyBindings, users } from '@/lib/prisma';
import { eq } from 'drizzle-orm';
import { getDecryptedBYOKKeyById, updateBYOKAvailableModels } from '@/lib/ai-key-vault';
import { fetchByokModels } from '@/lib/byok-models';

export type HealthCheckResult = {
  bindingId: string;
  userId: string;
  provider: string;
  status: 'healthy' | 'failed' | 'deactivated';
  error?: string;
};

type EmailSender = (to: string, subject: string, body: string) => Promise<void>;

const MODELS_REFRESH_PER_RUN = 50;
const MODELS_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MODELS_FETCH_TIMEOUT_MS = 5_000;

/** 经 aster-api 查询并写入 availableModels。返回「是否真的发起了查询」供预算计数：vertex 与 24h 内已查返回 false（不计），查询失败也返回 true（计入尝试，避免故障时反复打 api）。 */
async function refreshAvailableModels(
  b: { id: string; userId: string; provider: string; providerUrl: string | null; modelsCheckedAt?: Date | null },
  apiKey: string,
): Promise<boolean> {
  if (b.provider !== 'openai' && b.provider !== 'anthropic') return false;
  if (b.modelsCheckedAt && Date.now() - b.modelsCheckedAt.getTime() < MODELS_REFRESH_INTERVAL_MS) return false;
  const res = await fetchByokModels(b.userId, { provider: b.provider, apiKey, baseUrl: b.providerUrl ?? null },
    { timeoutMs: MODELS_FETCH_TIMEOUT_MS });
  if (!res.ok) {
    console.warn('[byok-healthcheck] models refresh failed for binding=%s: %s', b.id, res.error);
    return true;
  }
  try {
    await updateBYOKAvailableModels(b.id, { models: res.models, defaultModel: res.defaultModel });
  } catch (e) {
    console.warn('[byok-healthcheck] availableModels write failed for binding=%s:', b.id, e);
  }
  return true;
}

/**
 * 扫描所有 active BYOK 并 ping 验证
 *
 * 失败逻辑：
 *   - 第 1-2 次失败：写 lastErrorAt + lastError，仍保持 active
 *   - 第 3 次失败：active=false + 邮件通知用户
 *
 * "第 N 次失败" = 上次 lastErrorAt < 1 day 内 + 这次又失败
 */
export async function checkAllBYOKKeys(sendEmail: EmailSender): Promise<HealthCheckResult[]> {
  const bindings = await db.query.aiKeyBindings.findMany({
    where: eq(aiKeyBindings.active, true),
  });

  const results: HealthCheckResult[] = [];
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  let refreshAttempts = 0;

  for (const b of bindings) {
    // 多 key：按**本行 id** 解密（不能再按 provider 取——同 provider 多 key 会都 ping 到同一个）。
    const apiKey = await getDecryptedBYOKKeyById(b.userId, b.id);
    if (!apiKey) {
      results.push({ bindingId: b.id, userId: b.userId, provider: b.provider, status: 'failed', error: 'decrypt_failed' });
      continue;
    }

    const pingResult = await pingProvider(b.provider, apiKey);

    if (pingResult.ok) {
      // 健康：更新 lastCheckedAt（healthcheck ping，非真实推理）+ 清空错误状态。
      // 【不再写 lastUsedAt】——lastUsedAt 语义收敛为"最近真实推理使用"（Phase 4），只由
      // recordAiUsage 在 BYOK 成功推理时 stamp，避免 cron ping 冒充"最近使用"误导 dashboard。
      await db
        .update(aiKeyBindings)
        .set({ lastCheckedAt: new Date(), lastErrorAt: null, lastError: null, updatedAt: new Date() })
        .where(eq(aiKeyBindings.id, b.id));
      // ADR 0048：顺带刷新可用模型列表（仅校验/提示用）。失败不影响健康状态，也不动 lastError。
      // 预算：只刷 24h 未查过的，每轮最多尝试 MODELS_REFRESH_PER_RUN 次（成败都算），单次 5 s 超时，
      // 新增耗时 ≤ 50 × 5 s；原有逐 binding ping 不受影响。
      if (refreshAttempts < MODELS_REFRESH_PER_RUN && await refreshAvailableModels(b, apiKey)) refreshAttempts += 1;
      results.push({ bindingId: b.id, userId: b.userId, provider: b.provider, status: 'healthy' });
      continue;
    }

    // 失败：判断是不是连续第 3 次
    const recentlyFailed = b.lastErrorAt && b.lastErrorAt > oneDayAgo;
    if (recentlyFailed) {
      // 已有近期失败 → 这次是第 3 次（24h 内 cron 不止跑一次的兜底）
      // 自动停用
      await db
        .update(aiKeyBindings)
        .set({
          active: false,
          lastErrorAt: new Date(),
          lastError: pingResult.error,
          updatedAt: new Date(),
        })
        .where(eq(aiKeyBindings.id, b.id));

      // 通知用户
      const user = await db.query.users.findFirst({
        where: eq(users.id, b.userId),
        columns: { email: true, name: true },
      });
      if (user?.email) {
        await sendEmail(
          user.email,
          `Aster Cloud：你的 ${b.provider} API key 已自动停用`,
          [
            `Hi ${user.name || ''}，`,
            ``,
            `我们检测到你绑定的 ${b.provider} API key 连续多次调用失败：`,
            `  错误：${pingResult.error}`,
            `  停用时间：${new Date().toISOString()}`,
            ``,
            `常见原因：`,
            `  - API key 已被你在 ${b.provider} 控制台撤销`,
            `  - 账户余额不足`,
            `  - API key 权限被限制`,
            ``,
            `请到 https://aster-lang.cloud/settings/ai-keys 更新你的 key。`,
            `在更新前，AI 调用将走平台默认配额（Free 20 次/月，Pro 500 次/席位/月）。`,
          ].join('\n')
        );
      }

      results.push({ bindingId: b.id, userId: b.userId, provider: b.provider, status: 'deactivated', error: pingResult.error });
    } else {
      // 第 1-2 次失败：仅记录
      await db
        .update(aiKeyBindings)
        .set({
          lastErrorAt: new Date(),
          lastError: pingResult.error,
          updatedAt: new Date(),
        })
        .where(eq(aiKeyBindings.id, b.id));
      results.push({ bindingId: b.id, userId: b.userId, provider: b.provider, status: 'failed', error: pingResult.error });
    }
  }

  return results;
}

/**
 * 用 1 token 的极小 chat completion 探测 key 是否有效
 * 不消耗用户 quota，且不需要返回有意义内容
 */
async function pingProvider(provider: string, apiKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const url = providerEndpoint(provider);
    const headers = providerHeaders(provider, apiKey);
    const body = providerPingBody(provider);

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });

    if (res.ok) return { ok: true };

    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: `${res.status} 未授权（key 已被撤销或无效）` };
    }
    if (res.status === 402 || res.status === 429) {
      return { ok: false, error: `${res.status} 余额/配额不足` };
    }
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

function providerEndpoint(p: string): string {
  switch (p) {
    case 'openai': return 'https://api.openai.com/v1/chat/completions';
    case 'anthropic': return 'https://api.anthropic.com/v1/messages';
    case 'vertex': return 'https://us-central1-aiplatform.googleapis.com/v1/...'; // 占位
    default: throw new Error('unsupported provider: ' + p);
  }
}

function providerHeaders(p: string, key: string): Record<string, string> {
  switch (p) {
    case 'openai':
      return { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };
    case 'anthropic':
      return { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
    case 'vertex':
      return { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };
    default: return {};
  }
}

function providerPingBody(p: string): unknown {
  switch (p) {
    case 'openai':
      return {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      };
    case 'anthropic':
      return {
        model: 'claude-3-haiku-20240307',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      };
    default: return { ping: true };
  }
}
