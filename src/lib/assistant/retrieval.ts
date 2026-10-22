/**
 * 站内助手的检索核心（纯函数，无 React / 无网络 / 无 DB）。
 *
 * <p><b>这不是联网 AI 聊天</b>：不调任何 LLM、不出站、不读用户数据。它把用户的
 * 自然语言问句映射到**站内已有的两类事实源**：
 * <ul>
 *   <li>文档索引 —— 复用 {@link searchDocs}（三语，75 篇，标题/描述/小节加权）</li>
 *   <li>导航与快捷动作 —— 复用命令面板的 {@link Command} 列表</li>
 * </ul>
 * 因此答案永远可点击溯源，不存在幻觉编造。
 *
 * <p>抽成纯函数是为了能脱离 DOM 逐条断言排序与边界（见 retrieval.test.ts）。
 */

import { searchDocs, type SearchIndex } from '@/lib/docs/search-runtime';
import type { Command } from '@/components/dashboard/command-palette-commands';

/** 一条可点击的检索结果。 */
export interface AssistantHit {
  /** 稳定去重键。 */
  id: string;
  /** doc=站内文档；action=导航/动作；external=站外文档（aster-lang.dev）。 */
  kind: 'doc' | 'action' | 'external';
  title: string;
  /** 文档为 description；动作为所属分组名。 */
  subtitle?: string;
  href: string;
  /**
   * 站外来源标识（仅 kind='external'），用于在 UI 上标注"来自 aster-lang.dev"
   * 并让用户知道点击会离站。站内结果为 undefined。
   */
  sourceLabel?: string;
  /** 越大越靠前（仅同一次调用内可比）。 */
  score: number;
}

export interface RetrieveOptions {
  /** 文档索引（按当前 locale 预加载）。 */
  docsIndex: SearchIndex;
  /** 命令面板的导航/动作列表。 */
  commands: readonly Command[];
  /**
   * 文档路由前缀（en 为 ''，其余为 `/<locale>`）。
   *
   * <p>★索引里的 slug 是**相对**的（`api/policies/versions`），直接当 href 用会
   * 相对当前路径解析成 `/zh/docs/getting-started/api/...` 这种 404。
   * 与 DocsCommandPalette 的 buildHref 同口径。
   */
  docsPrefix: string;
  /**
   * 站外文档源（aster-lang.dev），可选。
   *
   * <p>索引在**构建期**从 aster-lang.dev 抓取并内联进 bundle——不做运行时抓站：
   * 那会让站点改版静默失效、网络抖动就答不出，与"答案可溯源"的产品承诺相悖。
   */
  external?: {
    index: SearchIndex;
    /** 绝对 URL 前缀，例如 `https://www.aster-lang.dev/zh`。 */
    baseUrl: string;
    /** UI 上展示的来源名，例如 `aster-lang.dev`。 */
    label: string;
  };
  /** 返回条数上限。 */
  limit?: number;
}

/** 文档命中的基准分（searchDocs 的分层分数已足够区分，这里只做跨源归一）。 */
const DOC_BASE = 1;
/**
 * 站外结果的分数折扣。
 *
 * <p>0.9 而非更低：站外文档（语言指南、stdlib 等）常常是唯一答案来源，
 * 压太狠会让它们永远进不了 limit。同分让位、不同分不干扰。
 */
const EXTERNAL_PENALTY = 0.9;
/** 动作命中的分层：完整短语 > 标签前缀 > 关键词命中。 */
const ACTION_EXACT = 1200;
const ACTION_PREFIX = 800;
const ACTION_KEYWORD = 600;

/** 同分排序权重：越小越靠前。 */
const KIND_ORDER: Record<AssistantHit['kind'], number> = { doc: 0, external: 1, action: 2 };

/** 归一：小写 + 去首尾空白（中文无大小写，保持原样即可）。 */
function norm(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * 给导航/动作打分。
 *
 * <p>中文查询没有空格分词，故**同时**用整串匹配与按空白切分的 token 匹配——
 * 只按空白切会让「新建策略」这种连写查询完全命中不到。
 */
function scoreCommand(cmd: Command, query: string): number | null {
  const q = norm(query);
  if (!q) return null;

  const label = norm(cmd.label);
  const haystack = [label, ...(cmd.keywords ?? []).map(norm)];

  // 整串：完全相等 > 前缀 > 包含
  for (const h of haystack) {
    if (h === q) return ACTION_EXACT;
  }
  for (const h of haystack) {
    if (h.startsWith(q)) return ACTION_PREFIX;
  }
  for (const h of haystack) {
    if (h.includes(q)) return ACTION_KEYWORD;
  }

  // 空格分词：任一 token 命中即算（英文/德文多词查询）
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length > 1) {
    const hit = tokens.some((t) => haystack.some((h) => h.includes(t)));
    if (hit) return ACTION_KEYWORD - 100;
  }
  return null;
}

/**
 * 执行检索。空查询返回空数组（调用方据此显示引导语而非空列表）。
 *
 * <p>排序：先按分数降序；同分时**文档优先于动作**——用户问「怎么…」时
 * 说明性文档比跳转按钮更可能是想要的答案。最后按 id 稳定排序，
 * 保证同一查询每次结果顺序一致（避免 UI 抖动）。
 */
export function retrieve(query: string, opts: RetrieveOptions): AssistantHit[] {
  const q = query.trim();
  if (!q) return [];

  const limit = opts.limit ?? 8;
  const hits: AssistantHit[] = [];

  for (const hit of searchDocs(q, opts.docsIndex, { limit: limit * 2 })) {
    hits.push({
      id: `doc:${hit.entry.slug}`,
      kind: 'doc',
      title: hit.entry.title || hit.entry.slug,
      subtitle: hit.entry.description || undefined,
      href: `${opts.docsPrefix}/docs/${hit.entry.slug}`,
      score: hit.score * DOC_BASE,
    });
  }

  if (opts.external) {
    const { index, baseUrl, label } = opts.external;
    for (const hit of searchDocs(q, index, { limit: limit * 2 })) {
      hits.push({
        id: `external:${hit.entry.slug}`,
        kind: 'external',
        title: hit.entry.title || hit.entry.slug,
        subtitle: hit.entry.description || undefined,
        href: `${baseUrl}/docs/${hit.entry.slug}`,
        sourceLabel: label,
        // ★站外分数打折：同等相关度下站内内容优先。用户在 aster-cloud 里提问，
        //   多数时候想要的是本站的操作路径，而不是跳去另一个站看语言说明。
        score: hit.score * DOC_BASE * EXTERNAL_PENALTY,
      });
    }
  }

  for (const cmd of opts.commands) {
    const score = scoreCommand(cmd, q);
    if (score === null) continue;
    hits.push({
      id: `action:${cmd.id}`,
      kind: 'action',
      title: cmd.label,
      subtitle: cmd.group,
      href: cmd.href,
      score,
    });
  }

  // 文档类命中的入列顺序即 searchDocs 的排序（它在同分内还按命中完整度、覆盖度细排），
  // 同分时沿用该顺序，而不是退回 id 字典序把细排结果打乱。
  const docRank = new Map(hits.filter((h) => h.kind !== 'action').map((h, i) => [h.id, i]));

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // 同分时：站内文档 > 站外文档 > 动作。用户问"怎么…"时说明性内容
    // 比跳转按钮更可能是答案；而本站内容又比离站内容更贴近当前上下文。
    if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (a.kind !== 'action') return docRank.get(a.id)! - docRank.get(b.id)!;
    return a.id.localeCompare(b.id);
  });

  return hits.slice(0, limit);
}

/** 送给 aster-api 的一条 grounding（AssistantRequest.GroundingHit）。 */
export interface GroundingHitPayload {
  title: string;
  snippet: string;
  href: string;
}

/** 与 aster-api AssistantRequest.groundingHits 的上限对齐（超出会被 400 拒绝）。 */
export const MAX_GROUNDING_HITS = 16;

/**
 * 检索命中 → 请求体里的 groundingHits。浏览器应答器与服务端补检索共用，保证两条路径送给
 * 模型的形状一致：只送作答需要的三个字段，score/kind/id 对生成无用，白送只会放大 prompt。
 */
export function toGroundingHits(hits: readonly AssistantHit[]): GroundingHitPayload[] {
  return hits.slice(0, MAX_GROUNDING_HITS).map((h) => ({
    title: h.title,
    snippet: h.subtitle ?? '',
    href: h.href,
  }));
}
