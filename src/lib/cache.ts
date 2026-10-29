/**
 * Cloudflare KV 缓存服务
 *
 * 提供统一的缓存接口，用于：
 * - 策略内容缓存（减少数据库读取）
 * - 用户会话缓存（加速认证）
 * - API 响应缓存（减少后端调用）
 */

// KV 命名空间类型（Cloudflare Workers 环境）
interface KVNamespace {
  get(key: string, options?: { type?: 'text' | 'json' | 'arrayBuffer' | 'stream' }): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
  delete(key: string): Promise<void>;
}

// Cloudflare 环境类型
interface CloudflareEnv {
  CACHE?: KVNamespace;
}

// 缓存键前缀
const CACHE_PREFIX = {
  // v4：缓存内容来源由活跃版本改为审批规则解析出的可执行版本。
  // 使旧条目失效，避免审批前缓存的源码绕过版本门控。
  // v2 曾加回放地基字段（versionRowId/sourceToolchainId/vocabSnapshotIds，ADR 0030）。旧条目自然
  // TTL 过期（≤1h）。
  POLICY: 'policy:v4:',
  POLICY_CONTENT: 'policy-content:',
  USER: 'user:',
  SESSION: 'session:',
} as const;

// 默认 TTL（秒）
// POLICY / POLICY_CONTENT 用较长 TTL：策略元数据/内容很少变，且更新/删除时
// invalidatePolicyCache 会**显式删除**缓存（见 policies/[id]/route.ts），TTL 只是
// 兜底过期。短 TTL（旧 5/10 分钟）会让同一策略每隔几分钟就 cache-miss 回落全量
// DB 路径（owner 冻结检查等额外串行查询）→ 用户感知「预热后偶尔又变慢」。拉长到
// 1 小时让预热持久，过期/变更两条失效路径都健全，无陈旧风险。
const DEFAULT_TTL = {
  POLICY: 3600,         // 1 小时（变更走显式失效，非靠过期）
  POLICY_CONTENT: 3600, // 1 小时
  USER: 300,            // 5 分钟（用量/套餐变动更频繁，保持短）
  SESSION: 3600,        // 1 小时
} as const;

/**
 * 尝试从 OpenNext 获取 Cloudflare 上下文
 */
async function getCloudflareEnv(): Promise<CloudflareEnv | null> {
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare');
    const context = await getCloudflareContext({ async: true });
    return context.env as CloudflareEnv;
  } catch {
    return null;
  }
}

/**
 * 获取 KV 命名空间
 * 在非 Cloudflare 环境返回 null
 */
async function getKV(): Promise<KVNamespace | null> {
  const env = await getCloudflareEnv();
  return env?.CACHE ?? null;
}

/**
 * 缓存策略内容
 */
export async function cachePolicyContent(
  policyId: string,
  content: string,
  ttl: number = DEFAULT_TTL.POLICY_CONTENT
): Promise<void> {
  const kv = await getKV();
  if (!kv) return;

  try {
    await kv.put(`${CACHE_PREFIX.POLICY_CONTENT}${policyId}`, content, {
      expirationTtl: ttl,
    });
  } catch (error) {
    console.warn('[Cache] Failed to cache policy content:', error);
  }
}

/**
 * 获取缓存的策略内容
 */
export async function getCachedPolicyContent(policyId: string): Promise<string | null> {
  const kv = await getKV();
  if (!kv) return null;

  try {
    return await kv.get(`${CACHE_PREFIX.POLICY_CONTENT}${policyId}`);
  } catch (error) {
    console.warn('[Cache] Failed to get cached policy content:', error);
    return null;
  }
}

/**
 * 缓存策略元数据（id, name, userId, teamId, isPublic）
 */
export interface CachedPolicyMeta {
  id: string;
  name: string;
  userId: string;
  teamId: string | null;
  isPublic: boolean;
  content: string;
  /**
   * 活跃版本冻结的用户关键词别名（ADR 0022，canonical JSON 字符串，NULL=无别名）。
   * 执行时透传给 evaluate-source 使别名源码能编译（C1）。与 content 同源（同一活跃版本）。
   */
  aliasSet?: string | null;
  /**
   * 回放地基（ADR 0030 附录 A）——活跃 PolicyVersion 的不可变引用字段，缓存以便 cache-hit
   * 的执行也能落 Execution.policyVersionRowId/sourceToolchainId/vocabSnapshotRef。缺这些则
   * cache-hit 执行的回放行缺版本引用，按版本聚合漂移会漏一批。与 content/aliasSet 同源。
   * （POLICY 缓存 key 已 bump 到 v4，见 CACHE_PREFIX.POLICY。）
   */
  versionRowId?: string | null;
  /** 人类可读版本号（Policy.version）——落 Execution.policyVersion，证据包显示「第几版」。 */
  version?: number | null;
  sourceToolchainId?: string | null;
  vocabSnapshotIds?: unknown;
}

export async function cachePolicyMeta(
  policyId: string,
  meta: CachedPolicyMeta,
  ttl: number = DEFAULT_TTL.POLICY
): Promise<void> {
  const kv = await getKV();
  if (!kv) return;

  try {
    await kv.put(`${CACHE_PREFIX.POLICY}${policyId}`, JSON.stringify(meta), {
      expirationTtl: ttl,
    });
  } catch (error) {
    console.warn('[Cache] Failed to cache policy meta:', error);
  }
}

/**
 * 获取缓存的策略元数据
 */
export async function getCachedPolicyMeta(policyId: string): Promise<CachedPolicyMeta | null> {
  const kv = await getKV();
  if (!kv) return null;

  try {
    const data = await kv.get(`${CACHE_PREFIX.POLICY}${policyId}`);
    if (!data) return null;
    return JSON.parse(data) as CachedPolicyMeta;
  } catch (error) {
    console.warn('[Cache] Failed to get cached policy meta:', error);
    return null;
  }
}

/**
 * 失效策略缓存（更新或删除策略时调用）
 */
export async function invalidatePolicyCache(policyId: string): Promise<void> {
  const kv = await getKV();
  if (!kv) return;

  try {
    await Promise.all([
      kv.delete(`${CACHE_PREFIX.POLICY}${policyId}`),
      kv.delete(`${CACHE_PREFIX.POLICY_CONTENT}${policyId}`),
    ]);
  } catch (error) {
    console.warn('[Cache] Failed to invalidate policy cache:', error);
  }
}

/**
 * 失效策略缓存并报告结果（供内部失效端点向调用方返回失败信号；业务写路径用 {@link invalidatePolicyCache}）。
 * 无 KV binding 返回 'kv_unavailable'；KV 删除失败原样抛出。
 */
export async function invalidatePolicyCacheReporting(policyId: string): Promise<'invalidated' | 'kv_unavailable'> {
  const kv = await getKV();
  if (!kv) return 'kv_unavailable';
  await Promise.all([
    kv.delete(`${CACHE_PREFIX.POLICY}${policyId}`),
    kv.delete(`${CACHE_PREFIX.POLICY_CONTENT}${policyId}`),
  ]);
  return 'invalidated';
}

/**
 * 缓存用户数据（plan, trialEndsAt）
 */
export interface CachedUserData {
  plan: string;
  trialEndsAt: string | null;
}

export async function cacheUserData(
  userId: string,
  data: CachedUserData,
  ttl: number = DEFAULT_TTL.USER
): Promise<void> {
  const kv = await getKV();
  if (!kv) return;

  try {
    await kv.put(`${CACHE_PREFIX.USER}${userId}`, JSON.stringify(data), {
      expirationTtl: ttl,
    });
  } catch (error) {
    console.warn('[Cache] Failed to cache user data:', error);
  }
}

/**
 * 获取缓存的用户数据
 */
export async function getCachedUserData(userId: string): Promise<CachedUserData | null> {
  const kv = await getKV();
  if (!kv) return null;

  try {
    const data = await kv.get(`${CACHE_PREFIX.USER}${userId}`);
    if (!data) return null;
    return JSON.parse(data) as CachedUserData;
  } catch (error) {
    console.warn('[Cache] Failed to get cached user data:', error);
    return null;
  }
}

/**
 * 失效用户缓存
 */
export async function invalidateUserCache(userId: string): Promise<void> {
  const kv = await getKV();
  if (!kv) return;

  try {
    await kv.delete(`${CACHE_PREFIX.USER}${userId}`);
  } catch (error) {
    console.warn('[Cache] Failed to invalidate user cache:', error);
  }
}

/**
 * 通用缓存函数 - 带回退的缓存读取
 * 如果缓存命中，返回缓存数据
 * 如果缓存未命中，调用 fetcher 获取数据并缓存
 */
export async function withCache<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttl: number = 300
): Promise<T> {
  const kv = await getKV();

  // 如果没有 KV，直接调用 fetcher
  if (!kv) {
    return fetcher();
  }

  try {
    // 尝试从缓存读取
    const cached = await kv.get(key);
    if (cached) {
      return JSON.parse(cached) as T;
    }
  } catch (error) {
    console.warn('[Cache] Failed to read cache:', error);
  }

  // 缓存未命中，调用 fetcher
  const data = await fetcher();

  // 异步写入缓存（不阻塞响应）
  try {
    kv.put(key, JSON.stringify(data), { expirationTtl: ttl }).catch((err) =>
      console.warn('[Cache] Failed to write cache:', err)
    );
  } catch (error) {
    console.warn('[Cache] Failed to initiate cache write:', error);
  }

  return data;
}
