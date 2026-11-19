/**
 * useUserVocabularyRegistration 并入策略内嵌词汇（ADR 0060 §6.3、§7.5，计划 T11）：
 *   - 内嵌词条不经作用域筛选，优先于作者 / 团队词条；编辑器的有效词汇与 registrationKey 等于服务端
 *     loadSaveVocabulary 的 vocabularyScopesJson(mergeEmbeddedVocabulary(...))，所以浏览器编译、LSP 与封印一致；
 *   - 浏览器编译用这份词汇时 `思故乡` 展开为 "静夜思"（规范预览与执行同一结果）；
 *   - 被遮蔽的下层词条在 terms 上带 shadowedByPolicy；
 *   - 内嵌词汇内容不变（仅顺序 / 引用变化）时 registrationKey 不变，LSP 不重新初始化。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@/hooks/useDomainVocabularyInvalidate', () => ({
  useDomainVocabularyInvalidate: () => 0,
}));

import { compileAndTypecheck, ZH_CN } from '@aster-cloud/aster-lang-ts/browser';
import { useUserVocabularyRegistration } from '@/hooks/useUserVocabularyRegistration';
import { resolvePolicyVocabularyFromRows, USER_VOCABULARY_DOMAIN } from '@/lib/domain-vocabulary-scope';
import { vocabularyScopesJson } from '@/lib/policy-alias';
import { mergeEmbeddedVocabulary, toDomainVocabulary, type EmbeddedVocabulary } from '@/lib/policy-embedded-vocabulary';

const SOURCE = '模块 明月光。\n规则 地上霜，产出 望明月：\n  返回 思故乡。';
const POEM: EmbeddedVocabulary = {
  v: 1,
  terms: [
    { kind: 'literal', localized: '思故乡', canonical: '静夜思' },
    { kind: 'struct', localized: '望明月', canonical: 'Text' },
  ],
};
// 作者事后新增的同形个人词条（Review Focus 2）
const AUTHOR_ITEMS = [
  { termId: 'a1', domain: 'poem', locale: 'zh', kind: 'struct', canonical: 'Moon', localized: '望明月' },
  { termId: 'a2', domain: 'poem', locale: 'zh', kind: 'struct', canonical: 'Frost', localized: '地上霜' },
];

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: [], total: 0 }) });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function serverScopes(rows: typeof AUTHOR_ITEMS, embedded: EmbeddedVocabulary): string {
  const lower = resolvePolicyVocabularyFromRows(
    rows.map((row) => ({ ...row, domainTermId: row.termId })),
    { source: SOURCE, locale: 'zh-CN' },
    { id: USER_VOCABULARY_DOMAIN },
  );
  return vocabularyScopesJson(mergeEmbeddedVocabulary(toDomainVocabulary(embedded, 'zh-CN'), lower).vocabulary);
}

describe('useUserVocabularyRegistration + 内嵌词汇', () => {
  it('没有个人词条：有效词汇就是内嵌词汇，key 等于服务端封印的词汇段', async () => {
    const { result } = renderHook(() =>
      useUserVocabularyRegistration({ tenantId: 't', locale: 'zh-CN', source: SOURCE, embedded: POEM }),
    );
    await waitFor(() => expect(result.current.vocabulary).toBeDefined());
    expect(result.current.vocabulary!.literals).toEqual([expect.objectContaining({ localized: '思故乡', canonical: '静夜思' })]);
    expect(result.current.vocabulary!.structs.map((m) => m.canonical)).toEqual(['Text']);
    expect(result.current.registrationKey).toBe(serverScopes([], POEM));
  });

  it('浏览器编译用这份词汇：思故乡 展开为 "静夜思"，没有错误', async () => {
    const { result } = renderHook(() =>
      useUserVocabularyRegistration({ tenantId: 't', locale: 'zh-CN', source: SOURCE, embedded: POEM }),
    );
    await waitFor(() => expect(result.current.vocabulary).toBeDefined());
    const compiled = compileAndTypecheck(SOURCE, { lexicon: ZH_CN, vocabulary: result.current.vocabulary } as never) as {
      success: boolean;
      core?: unknown;
      typeErrors?: Array<{ severity: string }>;
    };
    expect(compiled.success).toBe(true);
    expect((compiled.typeErrors ?? []).filter((d) => d.severity === 'error')).toEqual([]);
    expect(JSON.stringify(compiled.core)).toContain('静夜思');
  });

  it('不带内嵌词汇：同一源码编译失败（证明上一条确实依赖内嵌词汇）', () => {
    const compiled = compileAndTypecheck(SOURCE, { lexicon: ZH_CN } as never) as { success: boolean; typeErrors?: unknown[] };
    expect(compiled.success && (compiled.typeErrors ?? []).length === 0).toBe(false);
  });

  it('作者同形词条被内嵌词条遮蔽：有效词汇只剩 Text，标签页词条带 shadowedByPolicy；与服务端同一结果', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: AUTHOR_ITEMS, total: AUTHOR_ITEMS.length }) });
    const { result } = renderHook(() =>
      useUserVocabularyRegistration({ tenantId: 't', locale: 'zh-CN', source: SOURCE, embedded: POEM }),
    );
    await waitFor(() => expect(result.current.terms).toHaveLength(2));
    await waitFor(() => expect(result.current.vocabulary?.structs.map((m) => m.canonical).sort()).toEqual(['Frost', 'Text']));
    expect(result.current.terms.find((t) => t.canonical === 'Moon')?.shadowedByPolicy).toBe(true);
    expect(result.current.terms.find((t) => t.canonical === 'Frost')?.shadowedByPolicy).toBeUndefined();
    expect(result.current.registrationKey).toBe(serverScopes(AUTHOR_ITEMS, POEM));
  });

  it('内嵌词汇只是换了顺序 / 新对象：registrationKey 与词汇对象不变', async () => {
    const { result, rerender } = renderHook((embedded: EmbeddedVocabulary) =>
      useUserVocabularyRegistration({ tenantId: 't', locale: 'zh-CN', source: SOURCE, embedded }),
    { initialProps: POEM });
    await waitFor(() => expect(result.current.vocabulary).toBeDefined());
    const before = result.current;
    rerender({ v: 1, terms: [...POEM.terms].reverse() });
    expect(result.current.registrationKey).toBe(before.registrationKey);
    expect(result.current.vocabulary).toBe(before.vocabulary);
  });

  it('内嵌写法与本策略的关键词别名同形（保存会被拒）：不并入编辑器词汇', async () => {
    const clash: EmbeddedVocabulary = { v: 1, terms: [{ kind: 'literal', localized: '接 着', canonical: 'x' }] };
    const { result, rerender } = renderHook(
      (aliasSet: Record<string, string[]> | null) =>
        useUserVocabularyRegistration({ tenantId: 't', locale: 'zh-CN', source: SOURCE, embedded: clash, aliasSet }),
      { initialProps: null as Record<string, string[]> | null },
    );
    await waitFor(() => expect(result.current.vocabulary?.literals?.[0]?.localized).toBe('接 着'));
    rerender({ PLUS: ['接 着'] });
    expect(result.current.vocabulary).toBeUndefined();
    expect(result.current.registrationKey).toBe('');
  });

  it('无内嵌词汇：与引入前一致（无个人词条时没有词汇）', async () => {
    const { result } = renderHook(() =>
      useUserVocabularyRegistration({ tenantId: 't', locale: 'zh-CN', source: SOURCE, embedded: null }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current.vocabulary).toBeUndefined();
    expect(result.current.registrationKey).toBe('');
  });
});
