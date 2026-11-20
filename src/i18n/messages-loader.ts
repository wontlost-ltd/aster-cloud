/**
 * @module i18n/messages-loader
 *
 * 统一语言包 Phase 2（ADR 0018）：界面文案的**运行时加载**。
 *
 * 取代 request.ts 里构建期的 `await import('../../messages/<locale>.json')`，改为：
 *
 *   Workers KV (CACHE, 版本化 key)  ──miss──▶  后端 /api/v1/messages/<full-id>
 *                                                        │
 *                                          任意环节失败 ▼
 *                          内嵌 @aster-cloud/ui-messages(-hi) npm 包（构建期 bundle）
 *
 * **铁律：fail-open**。fetch / KV / 解析任何一步失败，都 fallback 到内嵌 messages
 * （构建期打进 bundle，源 = `@aster-cloud/ui-messages` npm 包，与后端 aster-api 同源），
 * **绝不让用户看到白屏**。这是 hero dashboard 崩溃教训的同款纪律：hot-path 必须降级到安全默认。
 *
 * 这样后端加一门语言（或改文案）→ 前端运行时 fetch 到新 messages → **无需重新
 * 构建部署**即可显示（前端热插拔贯通）。后端 messages 未发版时，内嵌副本兜底，
 * 行为与改造前完全一致。
 */

import { defaultLocale, type Locale } from './config';
import { resolvePolicyApiBaseUrl } from '@/lib/policy-api-url';

/** cloud 短码 locale → 后端 lexicon 全码 id（/api/v1/messages 的主键）。 */
const LOCALE_ID_MAP: Record<Locale, string> = {
  en: 'en-US',
  zh: 'zh-CN',
  de: 'de-DE',
  hi: 'hi-IN',
};

const API_BASE =
  resolvePolicyApiBaseUrl(process.env.NEXT_PUBLIC_ASTER_POLICY_API_URL);

/**
 * 版本化 KV body 的 TTL（秒）。key 含 sha → 内容对某 key 不可变（版本变则 key 变），
 * 故 TTL 长一些只是回收旧版本 entry 的上限，不影响新鲜度（新鲜度由 manifest sha 保证）。
 */
const KV_BODY_TTL_SECONDS = 86_400; // 1 天

/**
 * manifest（locale→sha 版本表）的回源缓存窗口（秒）。manifest 是版本源，要相对快地
 * 反映后端 sha 变化，但不必每个 SSR 请求都打后端——用 Next fetch 缓存兜一层。
 */
const MANIFEST_REVALIDATE_SECONDS = 60;

type MessageTree = Record<string, unknown>;

/** KV 命名空间最小接口（与 lib/cache.ts 一致）。 */
interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

interface CloudflareEnv {
  CACHE?: KVNamespace;
}

/** 取 Workers KV（非 Cloudflare 环境 / 本地 dev 返回 null → 直接回源，仍可用）。 */
async function getKV(): Promise<KVNamespace | null> {
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare');
    const context = await getCloudflareContext({ async: true });
    return (context.env as CloudflareEnv)?.CACHE ?? null;
  } catch {
    return null;
  }
}

/**
 * 内嵌 messages（构建期 bundle）—— 最终兜底，永不失败。
 *
 * 真相源 = `@aster-cloud/ui-messages`(en/zh/de) + `@aster-cloud/ui-messages-hi`(hi) npm 包
 * （ADR 0018，aster-lang-locales / aster-lang-hi 仓发布）。cloud 不再手维护 `messages/*`：
 * 单一真相源，与后端 aster-api 同源，杜绝漂移。
 *
 * 包内文件按**全码 id**命名（en-US.json），hi 在独立的 `-hi` 包。静态列举各 locale 的
 * import 表达式（而非模板字面量），让打包器能正确解析子包资源、按需加载。
 */
const EMBEDDED_LOADERS: Record<Locale, () => Promise<{ default: MessageTree }>> = {
  en: () => import('@aster-cloud/ui-messages/en-US.json'),
  zh: () => import('@aster-cloud/ui-messages/zh-CN.json'),
  de: () => import('@aster-cloud/ui-messages/de-DE.json'),
  hi: () => import('@aster-cloud/ui-messages-hi/hi-IN.json'),
};

async function loadEmbedded(locale: Locale): Promise<MessageTree> {
  try {
    return (await EMBEDDED_LOADERS[locale]()).default;
  } catch {
    // 连内嵌都失败（理论上不该发生）→ 退到 en，再不行返回空对象（next-intl 用 key 兜底）。
    if (locale !== defaultLocale) {
      try {
        return (await EMBEDDED_LOADERS[defaultLocale]()).default;
      } catch {
        /* fall through */
      }
    }
    return {};
  }
}

/** manifest 条目：{ locale: 全码 id, sha: 16 位版本 }。 */
interface ManifestEntry {
  locale: string;
  sha: string;
}

/**
 * 取某 locale 的 messages 版本 sha（ADR 0020 优化 1）。
 *
 * <p>回源 /api/v1/messages-manifest（带 Next fetch 缓存，60s 窗口），返回该 locale 的
 * 16 位 sha。失败 / 该 locale 不在 manifest → null（调用方退回固定 key 或内嵌兜底）。
 * sha 用于拼版本化 KV key：后端版本一变 → manifest sha 变 → KV key 换 → 边缘随版本
 * 即时刷新，不靠 body 的 TTL 等过期。
 */
async function fetchMessagesSha(fullId: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/messages-manifest`, {
      headers: { Accept: 'application/json' },
      // Worker fetch 缓存兜一层：manifest 小，60s 窗口够新鲜又不每请求打后端。
      next: { revalidate: MANIFEST_REVALIDATE_SECONDS },
    });
    if (!res.ok) return null;
    const entries = (await res.json()) as ManifestEntry[];
    return entries.find((e) => e.locale === fullId)?.sha ?? null;
  } catch (error) {
    console.warn(`[i18n] messages-manifest fetch failed:`, error);
    return null;
  }
}

/**
 * body 响应的 ETag 是否与 manifest sha 一致（ADR 0020 优化 1 的版本一致性校验）。
 *
 * <p>后端 messages 端点的 ETag = 完整 sha256；manifest 的 sha = 前 16 位。一致 = ETag
 * 去引号后以该 16 位 sha 开头。**无 manifest sha（走固定 key 路径）时返回 true**——没有
 * 版本契约可违反，固定 key 不涉及"错版本污染"。无 ETag 时保守返回 false（不回填版本化
 * key，避免把不可校验的 body 钉进版本 key）。
 */
function bodyMatchesSha(res: Response, sha: string | null): boolean {
  if (!sha) return true; // 固定 key 路径，无版本契约
  const etag = res.headers.get('ETag');
  if (!etag) return false; // 无法校验 → 不污染版本化 key
  const normalized = etag.replace(/^W\//, '').replace(/^"|"$/g, '');
  return normalized.startsWith(sha);
}

/**
 * 运行时获取某 locale 的界面文案：manifest 版本 → 版本化 KV → 后端 → 内嵌兜底。
 *
 * @returns 永远返回一个 MessageTree（fail-open，不抛）。
 */
export async function loadMessages(locale: Locale): Promise<MessageTree> {
  const fullId = LOCALE_ID_MAP[locale];
  if (!fullId) {
    return loadEmbedded(locale);
  }

  const kv = await getKV();

  // 1) 取版本（manifest sha）→ 版本化 KV key。manifest 不可达时退回固定 key
  //    （仍可用，只是回退到 TTL 失效语义，fail-open）。
  const sha = await fetchMessagesSha(fullId);
  const kvKey = sha ? `ui-messages:${fullId}:v${sha}` : `ui-messages:${fullId}`;

  // 2) 查 KV（版本化 key 命中 = 该版本内容，天然新鲜）
  if (kv) {
    try {
      const cached = await kv.get(kvKey);
      if (cached) {
        return JSON.parse(cached) as MessageTree;
      }
    } catch (error) {
      console.warn(`[i18n] KV read failed for ${kvKey}:`, error);
    }
  }

  // 3) 回源后端 /api/v1/messages/<full-id>（KV miss / 新版本）
  try {
    const res = await fetch(`${API_BASE}/api/v1/messages/${fullId}`, {
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const text = await res.text();
      const tree = JSON.parse(text) as MessageTree;
      // 异步回填版本化 KV（不阻塞响应）。版本化 key 内容不可变，给长 TTL 即可。
      // **版本一致性校验（Codex 审查）**：manifest 与 body 是两次独立请求；滚动发布/
      // 多实例/边缘缓存下，可能拿到新 sha 的 manifest 但旧 body。若直接把旧 body 写进
      // 新 `v<sha>` key，会被长 TTL 钉住 = 错版本污染。故仅当 body 的 ETag 与 manifest
      // sha 一致时才回填版本化 key；不一致只返回 body 给本次请求、不污染 KV。
      if (kv && bodyMatchesSha(res, sha)) {
        kv.put(kvKey, text, { expirationTtl: KV_BODY_TTL_SECONDS }).catch((err) =>
          console.warn(`[i18n] KV write failed for ${kvKey}:`, err)
        );
      } else if (kv && sha) {
        console.warn(
          `[i18n] body/manifest sha 不一致（${fullId} 期望 v${sha}），跳过 KV 回填避免错版本污染`
        );
      }
      return tree;
    }
    // 404（locale 未启用 / 未加载）等 → 落入内嵌兜底。
    console.warn(`[i18n] backend messages ${fullId} → HTTP ${res.status}; using embedded`);
  } catch (error) {
    console.warn(`[i18n] backend messages fetch failed for ${fullId}; using embedded:`, error);
  }

  // 4) 兜底：内嵌（绝不白屏）
  return loadEmbedded(locale);
}
