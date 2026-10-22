/**
 * Pure search runtime — substring + prefix matching with synonym
 * expansion. No third-party deps (Fuse / Lunr would each add several
 * KB of Worker bundle for marginal quality gain at our corpus size).
 *
 * Public surface:
 *   - `searchDocs(query, index, opts)` → ranked array of hits
 *   - `expandQuery(query, locale)` returns the synonym-extended token
 *     list for an input phrase, used by callers that want to highlight
 *     why a match was returned.
 *
 * Ranking (highest → lowest):
 *   1. Exact title match
 *   2. Title token-prefix match
 *   3. Heading match
 *   4. Description match
 *   5. Slug match (last resort — gives "graphql" → graphql/* anchors)
 *
 * Current-route boost: callers can pass `boostSlug` so the entry the
 * reader is currently on bubbles up. We add a fixed bonus, never
 * change the rank tiers, so cross-tier matches still beat in-tier
 * matches on the same page.
 */

import type { SynonymMap } from '@/lib/docs/synonyms';

export type SearchEntry = {
  slug: string;
  title: string;
  description: string;
  headings: string[];
};

export type SearchIndex = {
  locale: string;
  entries: SearchEntry[];
};

export type SearchHit = {
  entry: SearchEntry;
  /** Numeric score — higher is better. Stable per call, not absolute. */
  score: number;
  /** Which field surfaced the match — used by UI to show "matched in headings". */
  matchedIn: 'title' | 'heading' | 'description' | 'slug';
};

export type SearchOptions = {
  /** Slug of the page the reader is currently on. Adds a small boost. */
  boostSlug?: string;
  /** Synonym map for the active locale. Bypass with `{}` to disable. */
  synonyms?: SynonymMap;
  /** Maximum result count. */
  limit?: number;
};

const TIER_TITLE_EXACT = 1000;
const TIER_TITLE_PREFIX = 700;
const TIER_HEADING = 500;
const TIER_DESCRIPTION = 250;
const TIER_SLUG = 100;
const BOOST_CURRENT_ROUTE = 50;

/** Normalize a token: lowercase + strip surrounding punctuation. */
function normalize(token: string): string {
  return token.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/**
 * Expand a query into its canonical tokens plus every synonym that
 * resolves to the same canonical form. Unknown tokens pass through
 * verbatim so a user typing a specific identifier still finds it.
 */
/**
 * CJK 连写切片：对不含空格的中日韩文段，切出 2~4 字的滑动窗口。
 *
 * <p>★为什么需要：{@link expandQuery} 原本只按空白分词，而中文句子没有空格——
 * 「如何开始第一个策略的编写」会变成一个 12 字的整体 token，任何标题都不
 * 包含它，于是**整句检索零命中**（而「快速开始」单独搜是能命中的）。
 * 用户自然提问几乎必然落进这个坑。
 *
 * <p>不引入分词库（体积 + 这是要打进 Worker 的代码），用 n-gram 覆盖：
 * 2 字窗口足以命中「开始」「策略」「审批」这类领域词，4 字上限则能命中
 * 「快速开始」「版本历史」这类完整词组；再长的窗口对召回无益只增噪声。
 */
function cjkNgrams(text: string): string[] {
  const out: string[] = [];
  // 只对连续 CJK 段做切片，英文/数字仍走空白分词（它们本来就分得开）。
  for (const run of text.match(/[㐀-鿿぀-ヿ가-힯]+/gu) ?? []) {
    if (run.length < 2) continue;
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= run.length; i++) out.push(run.slice(i, i + n));
    }
  }
  return out;
}

export function expandQuery(query: string, synonyms: SynonymMap = {}): string[] {
  const rawTokens = query
    .split(/\s+/)
    .map(normalize)
    .filter((t) => t.length > 0);
  const expanded = new Set<string>();
  for (const token of rawTokens) {
    expanded.add(token);
    const canonical = synonyms[token];
    if (canonical) {
      expanded.add(canonical);
    }
    // 中文连写补 n-gram；同义词表对切片同样生效（如「登录」→「认证」）。
    for (const gram of cjkNgrams(token)) {
      expanded.add(gram);
      const c = synonyms[gram];
      if (c) expanded.add(c);
    }
  }
  return Array.from(expanded);
}

function fieldMatches(field: string, tokens: string[]): boolean {
  if (!field) return false;
  const low = field.toLowerCase();
  return tokens.some((tok) => low.includes(tok));
}

/**
 * 命中的最长 token 长度（0 = 未命中）。
 *
 * <p>★用于同层级内排序：CJK n-gram 会产生大量 2 字碎片，若只看层级，
 * 「版本历史」查询下「版本比较」（碎片"版本"命中）会和「获取策略版本历史」
 * （整词命中）同分，靠 slug 字典序决定谁在前——精确匹配反而排到最后。
 * 取最长命中长度作次级排序键，让"匹配得更完整"的条目稳定靠前。
 */
function longestMatchLen(field: string, tokens: string[]): number {
  if (!field) return 0;
  const low = field.toLowerCase();
  let best = 0;
  for (const tok of tokens) {
    if (tok.length > best && low.includes(tok)) best = tok.length;
  }
  return best;
}

function tokenPrefixMatches(field: string, tokens: string[]): boolean {
  if (!field) return false;
  const fieldTokens = field
    .toLowerCase()
    .split(/[\s/_-]+/)
    .filter((t) => t.length > 0);
  return tokens.some((tok) =>
    fieldTokens.some((ft) => ft.startsWith(tok)),
  );
}

function exactTitleMatch(title: string, tokens: string[]): boolean {
  return tokens.length === 1 && normalize(title) === tokens[0];
}

/** 条目在任一字段上的最长命中长度（跨字段取最大）。 */
function matchStrength(entry: SearchEntry, tokens: string[]): number {
  return Math.max(
    longestMatchLen(entry.title, tokens),
    longestMatchLen(entry.description, tokens),
    longestMatchLen(entry.slug, tokens),
    ...entry.headings.map((h) => longestMatchLen(h, tokens)),
  );
}

/** 条目任一字段命中的不同 token 个数。 */
function matchCoverage(entry: SearchEntry, tokens: string[]): number {
  const fields = [entry.title, entry.description, entry.slug, ...entry.headings].map((f) =>
    f.toLowerCase(),
  );
  return tokens.filter((tok) => fields.some((f) => f.includes(tok))).length;
}

/**
 * Score a single entry against the expanded token set. Returns the
 * first matching tier (we don't sum tiers — a heading match shouldn't
 * out-score a title match).
 */
function scoreEntry(
  entry: SearchEntry,
  tokens: string[],
  boostSlug?: string,
): { score: number; matchedIn: SearchHit['matchedIn'] } | null {
  let tier: { score: number; matchedIn: SearchHit['matchedIn'] } | null = null;
  if (exactTitleMatch(entry.title, tokens)) {
    tier = { score: TIER_TITLE_EXACT, matchedIn: 'title' };
  } else if (
    fieldMatches(entry.title, tokens) ||
    tokenPrefixMatches(entry.title, tokens)
  ) {
    tier = { score: TIER_TITLE_PREFIX, matchedIn: 'title' };
  } else if (entry.headings.some((h) => fieldMatches(h, tokens))) {
    tier = { score: TIER_HEADING, matchedIn: 'heading' };
  } else if (fieldMatches(entry.description, tokens)) {
    tier = { score: TIER_DESCRIPTION, matchedIn: 'description' };
  } else if (fieldMatches(entry.slug, tokens)) {
    tier = { score: TIER_SLUG, matchedIn: 'slug' };
  }
  if (!tier) return null;
  if (boostSlug && entry.slug === boostSlug) {
    tier = { ...tier, score: tier.score + BOOST_CURRENT_ROUTE };
  }
  return tier;
}

/**
 * Run a search query against an index. Pure function — safe to call
 * server- or client-side.
 */
export function searchDocs(
  query: string,
  index: SearchIndex,
  opts: SearchOptions = {},
): SearchHit[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const tokens = expandQuery(trimmed, opts.synonyms);
  if (tokens.length === 0) return [];

  const hits: SearchHit[] = [];
  for (const entry of index.entries) {
    const scored = scoreEntry(entry, tokens, opts.boostSlug);
    if (scored) {
      hits.push({ entry, score: scored.score, matchedIn: scored.matchedIn });
    }
  }
  hits.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    // 同层级内：命中更长的 token（更完整的匹配）优先，压住 CJK n-gram 碎片。
    const la = matchStrength(a.entry, tokens);
    const lb = matchStrength(b.entry, tokens);
    if (la !== lb) return lb - la;
    // 再同：命中的不同 token 更多（问句覆盖更全）优先。自然问句会拆出大量短 token，
    // 「如何创建 API 密钥」下只碰到 "api" 的条目不应靠 slug 字典序排到真正答案前面。
    const ca = matchCoverage(a.entry, tokens);
    const cb = matchCoverage(b.entry, tokens);
    if (ca !== cb) return cb - ca;
    return a.entry.slug.localeCompare(b.entry.slug);
  });
  const limit = opts.limit ?? 8;
  return hits.slice(0, limit);
}
