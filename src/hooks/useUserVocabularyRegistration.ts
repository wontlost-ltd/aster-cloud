/**
 * useUserVocabularyRegistration — 编辑器侧的作者领域词汇（ADR 0014 线B、ADR 0051）。
 *
 * 作用域规则与服务端编译门禁、审批冻结、执行完全一致（见 domain-vocabulary-scope）：
 * 与编辑器 CNL 语言相同、且被当前源码引用的 (domain, locale) 分组。流程：
 *   1. 拉取用户全部活跃词条（分页，不按 domain/locale 过滤——词条 locale 是自由填写的
 *      `de` 之类，与编译器的 `de-DE` 按主语言匹配）。
 *   2. 按当前源码选出作用域内分组，合并成一个词汇表，id 固定为 USER_VOCABULARY_DOMAIN。
 *   3. 用引擎 buildVocabularyScopes 构建按位置解析的 VocabularyScopes；编译直接传入该词汇，
 *      与服务端保存时（同一词汇 → 同一 scopes）逐字节一致，不再经租户注册表中转。
 *   4. 订阅词汇版本失效 tick（轮询 /api/v1/domain-vocabularies/version），用户增删词后重新拉取。
 *
 * 返回合并后的词汇（编译 / 高亮 / LSP 共用）、其 VocabularyScopes，以及以
 * canonicalScopesJson 为内容的稳定 key（与 envelope 第 5 段同值），供下游触发重编译/重高亮。
 */

'use client';

import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import {
  buildVocabularyScopes,
  canonicalScopesJson,
  type DomainVocabulary,
  type VocabularyScopes,
} from '@aster-cloud/aster-lang-ts/browser';
import type { TermLikeRow } from '@/lib/domain-vocabulary-assemble';
import {
  USER_VOCABULARY_DOMAIN,
  VOCABULARY_LIST_MAX_PAGE_SIZE,
  resolvePolicyVocabularyFromRows,
} from '@/lib/domain-vocabulary-scope';
import { useDomainVocabularyInvalidate } from '@/hooks/useDomainVocabularyInvalidate';

/** GET /api/v1/domain-vocabularies/terms 返回的单条链接（取用到的字段）。 */
interface TermLink {
  domainTermId?: string;
  termId?: string;
  domain: string;
  locale: string;
  kind: string;
  canonical: string;
  localized: string;
  parentCanonical?: string | null;
  aliases?: readonly string[] | null;
  description?: string | null;
}

interface ListResponse {
  items?: TermLink[];
  total?: number;
}

export interface UseUserVocabularyRegistrationOptions {
  /** 租户标识符；缺省（匿名/未登录）时不加载用户词汇。 */
  tenantId?: string;
  /** 编译器语言代码（如 'de-DE'）。 */
  locale: string;
  /** 当前策略源码，用于确定作用域内的词汇分组。 */
  source: string;
  /** 关闭注册（例如非策略编辑场景或匿名会话）。 */
  enabled?: boolean;
}

export interface UseUserVocabularyRegistrationResult {
  /** 作用域内的合并用户词汇（源码未引用任何用户词时为 undefined）。 */
  vocabulary: DomainVocabulary | undefined;
  /** 该词汇按位置解析的作用域视图（与服务端 buildVocabularyScopes 同源）。 */
  scopes: VocabularyScopes | undefined;
  /** canonicalScopesJson(scopes)；无词汇为空串。变化即需重编译/重高亮。 */
  registrationKey: string;
}

interface EditorVocabulary {
  readonly vocabulary: DomainVocabulary;
  readonly scopes: VocabularyScopes;
}

/** 把 API 行映射成 assemble 所需的最小行结构。 */
function toTermLikeRow(link: TermLink): TermLikeRow {
  return {
    domainTermId: link.domainTermId ?? link.termId ?? '',
    domain: link.domain,
    locale: link.locale,
    kind: link.kind,
    canonical: link.canonical,
    localized: link.localized,
    parentCanonical: link.parentCanonical ?? undefined,
    aliases: link.aliases ?? undefined,
    description: link.description ?? undefined,
  };
}

/**
 * 分页拉取用户全部活跃词条，直到读满服务端报告的 total——与服务端编译门禁/审批冻结
 * 读取全部活跃词条同一口径，不设额外上限。任一页失败返回 null（保持上一次结果）。
 */
async function fetchAllTermRows(): Promise<TermLikeRow[] | null> {
  const rows: TermLikeRow[] = [];
  for (let page = 1; ; page++) {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(VOCABULARY_LIST_MAX_PAGE_SIZE),
    });
    const res = await fetch(`/api/v1/domain-vocabularies/terms?${params.toString()}`, {
      credentials: 'include',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as ListResponse;
    const items = data.items ?? [];
    rows.push(...items.map(toTermLikeRow));
    // 空页兜底：total 与实际行数不一致（并发删除等）时也必然终止。
    if (items.length === 0 || rows.length >= (data.total ?? 0)) return rows;
  }
}

/**
 * 编辑器作用域内的合并词汇及其 VocabularyScopes。词汇无法构成作用域（字段 / 枚举成员缺 parent、
 * 字面量宏冲突，与服务端保存时 400 vocabulary_scope_invalid 同一判定）时返回 null，编辑器退回内置词汇。
 */
function resolveEditorVocabulary(
  rows: readonly TermLikeRow[],
  source: string,
  locale: string,
): EditorVocabulary | null {
  // 编辑中途源码可能无法词法分析，编辑器用 lenient 退化剥离（服务端路径一律严格）。
  const vocabulary = resolvePolicyVocabularyFromRows(rows, { source, locale }, {
    id: USER_VOCABULARY_DOMAIN,
    lenient: true,
  });
  if (!vocabulary) return null;
  try {
    return { vocabulary, scopes: buildVocabularyScopes(vocabulary) };
  } catch {
    return null;
  }
}

export function useUserVocabularyRegistration({
  tenantId,
  locale,
  source,
  enabled = true,
}: UseUserVocabularyRegistrationOptions): UseUserVocabularyRegistrationResult {
  const [rows, setRows] = useState<TermLikeRow[]>([]);
  const active = Boolean(enabled && tenantId);

  // 用户在任意 domain 增删词都可能改变作用域，故不按 (domain, locale) 过滤事件。
  const vocabTick = useDomainVocabularyInvalidate({ enabled: active });

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void fetchAllTermRows()
      .then((next) => {
        if (!cancelled && next) setRows(next);
      })
      .catch(() => {
        // 网络/解析失败：保持上一次结果，不影响编辑器可用性。
      });
    return () => {
      cancelled = true;
    };
  }, [active, tenantId, vocabTick]);

  // 作用域随源码变化；延迟值避免每次按键都同步扫描全部词条。
  const deferredSource = useDeferredValue(source);
  const scoped = useMemo(
    () => (active ? resolveEditorVocabulary(rows, deferredSource, locale) : null),
    [active, rows, deferredSource, locale],
  );
  // 以规范作用域 JSON 为 key：源码变化但作用域未变时不触发重编译。
  const registrationKey = scoped ? canonicalScopesJson(scoped.scopes) : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stable = useMemo(() => scoped ?? undefined, [registrationKey]);

  return useMemo(
    () => ({ vocabulary: stable?.vocabulary, scopes: stable?.scopes, registrationKey }),
    [stable, registrationKey],
  );
}
