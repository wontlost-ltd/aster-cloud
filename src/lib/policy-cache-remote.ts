/**
 * 经 cloud 内部端点失效策略执行缓存（Workers KV）。
 *
 * 执行入口命中 KV 时不查库；本地 {@link invalidatePolicyCache} 只在 Worker 内拿得到 KV。跑在 k8s 里的
 * 运维任务（resolver 迁移 Job）改了版本后，经 `POST /api/internal/policies/[id]/invalidate-cache`
 * 让 Worker 代为删除，否则旧条目要等 TTL（≤1 小时）才过期——期间被归档的版本仍可执行。
 */
import { signInternalV2Headers } from '@/lib/api-signing';

export interface RemoteCacheTarget {
  /** cloud 对内可达的基址，如 `https://aster-cloud.example`；末尾斜杠可有可无。 */
  baseUrl: string;
  /** 与 cloud 共享的内部签名密钥（ASTER_PLAN_GATE_HMAC_KEY）。 */
  secret: string;
}

const REMOTE_INVALIDATE_TIMEOUT_MS = 10_000;

/** 失效一个策略的执行缓存；非 2xx 或网络错误时抛出，由调用方决定是否只告警。 */
export async function invalidatePolicyCacheRemote(policyId: string, target: RemoteCacheTarget): Promise<void> {
  const base = target.baseUrl.replace(/\/+$/, '');
  const url = `${base}/api/internal/policies/${encodeURIComponent(policyId)}/invalidate-cache`;
  const headers = await signInternalV2Headers('POST', url, '', target.secret);
  const res = await fetch(url, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(REMOTE_INVALIDATE_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`cache invalidation endpoint returned HTTP ${res.status}`);
  }
}
