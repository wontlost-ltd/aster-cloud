/**
 * useUserVocabularyRegistration — 把当前策略作用域内的用户领域词汇注入 aster-lang-ts
 * 引擎的 vocabularyRegistry（per-tenant custom 词汇），让编译/翻译层（而非仅高亮层）
 * 也能识别用户自定义术语（ADR 0014 线B）。
 *
 * 作用域规则与服务端编译门禁、审批冻结、执行完全一致（见 domain-vocabulary-scope）：
 * 与编辑器 CNL 语言相同、且被当前源码引用的 (domain, locale) 分组。流程：
 *   1. 拉取用户全部活跃词条（分页，不按 domain/locale 过滤——词条 locale 是自由填写的
 *      `de` 之类，与编译器的 `de-DE` 按主语言匹配）。
 *   2. 按当前源码选出作用域内分组，合并成一个词汇表，id 固定为 USER_VOCABULARY_DOMAIN。
 *   3. 作用域内容变化时 `registerCustom(tenantId, vocab)`，作用域清空时撤销注册。
 *   4. 订阅词汇 SSE 失效 tick，用户增删词后重新拉取。
 *
 * 返回合并后的词汇（也喂给 Monaco 高亮）、编译器应使用的 domain，以及注册内容的稳定 key，
 * 供下游触发重编译/重高亮。
 */

'use client';

import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import {
  vocabularyRegistry,
  initBuiltinVocabularies,
  type DomainVocabulary,
} from '@/lib/aster-lexicon';
import type { TermLikeRow } from '@/lib/domain-vocabulary-assemble';
import {
  USER_VOCABULARY_DOMAIN,
  resolvePolicyVocabularyFromRows,
} from '@/lib/domain-vocabulary-scope';
import { validateVocabulary } from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';
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

/** 列表接口单页上限（domain-vocabulary.ts MAX_PAGE_SIZE）。 */
const PAGE_SIZE = 200;
/** 最多拉取的页数：覆盖最高档配额（5000 条）。 */
const MAX_PAGES = 25;

export interface UseUserVocabularyRegistrationOptions {
  /** 租户标识符；缺省（匿名/未登录）时跳过注册。 */
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
  /** 编译器应使用的 domain：有用户词汇时为 USER_VOCABULARY_DOMAIN。 */
  domain: string | undefined;
  /** 注册内容的稳定 key，变化即需重编译/重高亮。 */
  registrationKey: string;
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

/** 分页拉取用户全部活跃词条；任一页失败返回 null（保持上一次结果）。 */
async function fetchAllTermRows(): Promise<TermLikeRow[] | null> {
  const rows: TermLikeRow[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    const res = await fetch(`/api/v1/domain-vocabularies/terms?${params.toString()}`, {
      credentials: 'include',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as ListResponse;
    const items = data.items ?? [];
    rows.push(...items.map(toTermLikeRow));
    if (items.length < PAGE_SIZE || rows.length >= (data.total ?? 0)) break;
  }
  return rows;
}

/**
 * 编辑器作用域内的合并词汇；词汇自身冲突（如两个分组把同一规范名映射成不同词）时
 * 返回 null，回退内置词汇，而不是让 registerCustom 抛错。
 */
function resolveEditorVocabulary(
  rows: readonly TermLikeRow[],
  source: string,
  locale: string,
): DomainVocabulary | null {
  const vocabulary = resolvePolicyVocabularyFromRows(rows, { source, locale }, {
    id: USER_VOCABULARY_DOMAIN,
  });
  return vocabulary && validateVocabulary(vocabulary).valid ? vocabulary : null;
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
  // 以内容为 key：源码变化但作用域未变时不重新注册、不触发重编译。
  const registrationKey = scoped ? JSON.stringify(scoped) : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const vocabulary = useMemo(() => scoped ?? undefined, [registrationKey]);

  // 注入引擎 registry（外部系统同步）。本 hook 在编辑器里先于 useAsterCompiler 调用，
  // 同一次提交中注册 effect 先于编译 effect 执行，编译时已能查到新词汇。
  useEffect(() => {
    if (!active || !tenantId) return;
    initBuiltinVocabularies();
    vocabularyRegistry.unregisterCustom(tenantId, USER_VOCABULARY_DOMAIN, locale);
    if (vocabulary) vocabularyRegistry.registerCustom(tenantId, vocabulary);
  }, [active, tenantId, locale, vocabulary]);

  return useMemo(
    () => ({
      vocabulary,
      domain: vocabulary ? USER_VOCABULARY_DOMAIN : undefined,
      registrationKey,
    }),
    [vocabulary, registrationKey],
  );
}
