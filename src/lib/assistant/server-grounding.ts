/**
 * 站内助手的**服务端补检索**（F15）。
 *
 * <p>浏览器里的助手先在客户端检索、再把命中作为 groundingHits 送来；但 AI 工作台
 * （ai.aster-lang.cloud，ADR 0049）以服务身份调用 /api/llm/assistant 时没有这一步，
 * 恒送 `groundingHits: []`——问答模式因此永远没有依据，只能回答「本站文档中没有找到」。
 *
 * <p>这里用**同一套检索**（{@link retrieve} + 同一份构建期文档索引）在服务端补上命中，
 * 不另建索引、不出站：索引是打进 bundle 的 JSON（与 dashboard 命令面板、浏览器助手同源），
 * 在 Workers 上就是一次内存遍历。
 */

import {
  getDocsRoutePrefix,
  getDocsSearchIndex,
  getExternalDocs,
} from '@/lib/docs/dashboard-docs-seeds';
import { retrieve, toGroundingHits, type GroundingHitPayload } from './retrieval';

/** 与浏览器助手同一条数上限（assistant-panel 的 limit）。 */
const SERVER_RETRIEVAL_LIMIT = 8;

/** 'zh-CN' / 'de-DE' / 'zh' → 'zh' / 'de'；空值按 en。文档索引按短码组织。 */
export function docsLocaleOf(locale: unknown): string {
  if (typeof locale !== 'string' || !locale.trim()) return 'en';
  return locale.trim().split(/[-_]/)[0].toLowerCase();
}

export interface ServerGroundingOptions {
  /**
   * 站内链接的绝对化前缀（如 `https://aster-lang.cloud`）。
   * 调用方不在本站页面内（AI 工作台在另一个 origin）时必须给：相对路径在那边点开是 404。
   */
  absoluteOrigin?: string;
}

/**
 * 按问句在服务端检索文档（站内 + aster-lang.dev 站外索引），返回可直接放进请求体的 groundingHits。
 *
 * <p>不含导航动作：动作标签依赖界面语言包（服务端需额外加载 messages），且其摘要只是分组名，
 * 对作答没有信息量；站内文档（含「创建 API 密钥」等操作说明）已覆盖常见问题。
 */
export function retrieveServerGrounding(
  query: string,
  locale: unknown,
  { absoluteOrigin }: ServerGroundingOptions = {},
): GroundingHitPayload[] {
  const docsLocale = docsLocaleOf(locale);
  const hits = retrieve(query, {
    docsIndex: getDocsSearchIndex(docsLocale),
    commands: [],
    // 与浏览器助手同口径：hi 等无文档索引的语言回退 en，前缀随之回退。
    docsPrefix: getDocsRoutePrefix(docsLocale),
    external: getExternalDocs(docsLocale),
    limit: SERVER_RETRIEVAL_LIMIT,
  });
  return toGroundingHits(hits).map((h) =>
    absoluteOrigin && h.href.startsWith('/') ? { ...h, href: `${absoluteOrigin}${h.href}` } : h,
  );
}

/**
 * 给「答案下方没有检索结果列表」的调用方追加的说明（随 adminInstructions 下发）。
 * aster-api 的 system prompt 固定要求无依据时「请用户查看答案下方的搜索结果」，
 * 而 AI 工作台只显示答案本身——这句话在那里是错的指引。
 */
export const NO_RESULTS_UI_NOTE =
  'This answer is shown in the Aster AI workspace, which displays only your answer: there is NO list of search results below it. ' +
  'Never tell the user to check search results below the answer. ' +
  'If the excerpts do not cover the question, say so plainly and point to the most relevant excerpt link, if any.';
