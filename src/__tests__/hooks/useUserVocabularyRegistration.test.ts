/**
 * useUserVocabularyRegistration（#602 线B、ADR 0051）：编辑器按源码选出作用域内的用户词汇。
 *
 *   - 拉取全部词条（不按 domain/locale 过滤，`de` 词条适用于 de-DE 编译器）；
 *   - 只合并源码引用的同语言分组，并构建 VocabularyScopes；
 *   - 编辑器的 scopes 与服务端保存时的 canonicalScopesJson（envelope 第 5 段）逐字节一致；
 *   - 源码不再引用用户词时清空。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@/hooks/useDomainVocabularyInvalidate', () => ({
  useDomainVocabularyInvalidate: () => 0,
}));

import { canonicalScopesJson, compileAndTypecheck, DE_DE } from '@aster-cloud/aster-lang-ts/browser';
import { useUserVocabularyRegistration } from '@/hooks/useUserVocabularyRegistration';
import {
  USER_VOCABULARY_DOMAIN,
  VOCABULARY_LIST_MAX_PAGE_SIZE,
  resolvePolicyVocabularyFromRows,
} from '@/lib/domain-vocabulary-scope';
import { vocabularyScopesJson } from '@/lib/policy-alias';

const ITEMS = [
  { termId: 't1', domain: 'e2e1026', locale: 'de', kind: 'struct', canonical: 'Driver', localized: 'Fahrer' },
  { termId: 't2', domain: 'e2e1026', locale: 'de', kind: 'field', canonical: 'age', localized: 'alter', parentCanonical: 'Driver' },
  { termId: 't3', domain: 'e2etest', locale: 'en', kind: 'struct', canonical: 'Applicant', localized: 'Antragsteller' },
];

const SOURCE = 'Definiere Fahrer hat alter als Ganzzahl.';

describe('useUserVocabularyRegistration', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: ITEMS, total: ITEMS.length }) });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds scopes for only the in-scope groups', async () => {
    const { result } = renderHook(() =>
      useUserVocabularyRegistration({ tenantId: 'tenant-hook', locale: 'de-DE', source: SOURCE }),
    );

    await waitFor(() => expect(result.current.scopes).toBeDefined());
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).not.toContain('domain=');
    expect(url).not.toContain('locale=');
    expect(result.current.vocabulary!.id).toBe(USER_VOCABULARY_DOMAIN);
    expect(result.current.vocabulary!.structs.map((m) => m.canonical)).toEqual(['Driver']);
    expect([...result.current.scopes!.fields.get('Driver')!.keys()]).toEqual(['alter']);
  });

  it('editor scopes equal the server canonicalScopesJson for the same rows', async () => {
    const { result } = renderHook(() =>
      useUserVocabularyRegistration({ tenantId: 'tenant-hook', locale: 'de-DE', source: SOURCE }),
    );
    await waitFor(() => expect(result.current.scopes).toBeDefined());

    const rows = ITEMS.map((i) => ({ ...i, domainTermId: i.termId }));
    const server = vocabularyScopesJson(resolvePolicyVocabularyFromRows(rows, { source: SOURCE, locale: 'de-DE' }));
    expect(server).not.toBe('');
    expect(canonicalScopesJson(result.current.scopes!)).toBe(server);
    expect(result.current.registrationKey).toBe(server);
  });

  it('keeps position-aware vocabularies the old validator rejected (Stufe type + stufe field, cross-struct fields)', async () => {
    const items = [
      { termId: 's1', domain: 'grades', locale: 'de', kind: 'struct', canonical: 'Level', localized: 'Stufe' },
      { termId: 's2', domain: 'grades', locale: 'de', kind: 'struct', canonical: 'Driver', localized: 'Fahrer' },
      { termId: 'f1', domain: 'grades', locale: 'de', kind: 'field', canonical: 'level', localized: 'stufe', parentCanonical: 'Driver' },
      { termId: 'f2', domain: 'grades', locale: 'de', kind: 'field', canonical: 'level', localized: 'stufe', parentCanonical: 'Level' },
    ];
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items, total: items.length }) });
    const source = 'Definiere Stufe hat stufe als Ganzzahl.\nDefiniere Fahrer hat stufe als Stufe.';

    const { result } = renderHook(() =>
      useUserVocabularyRegistration({ tenantId: 'tenant-hook', locale: 'de-DE', source }),
    );

    await waitFor(() => expect(result.current.vocabulary).toBeDefined());
    const compiled = compileAndTypecheck(source, { lexicon: DE_DE, vocabulary: result.current.vocabulary });
    expect(compiled.success).toBe(true);
    expect(compiled.core?.decls.map((d) => (d as { name: string }).name)).toEqual(['Level', 'Driver']);
  });

  it('clears when the source no longer uses any user term', async () => {
    const { result, rerender } = renderHook(
      ({ source }) => useUserVocabularyRegistration({ tenantId: 'tenant-hook', locale: 'de-DE', source }),
      { initialProps: { source: SOURCE } },
    );
    await waitFor(() => expect(result.current.scopes).toBeDefined());

    rerender({ source: 'Definiere Auto hat preis als Ganzzahl.' });

    await waitFor(() => expect(result.current.scopes).toBeUndefined());
    expect(result.current.vocabulary).toBeUndefined();
    expect(result.current.registrationKey).toBe('');
  });

  it('pages through every term up to the server-reported total (no client-side cap)', async () => {
    // 前两页是无关填充词条，作用域内的词条只在第 3 页：拉取不能提前停止。
    const filler = (page: number) =>
      Array.from({ length: VOCABULARY_LIST_MAX_PAGE_SIZE }, (_, i) => ({
        termId: `f-${page}-${i}`, domain: 'filler', locale: 'de', kind: 'struct',
        canonical: `Filler${page}x${i}`, localized: `Fueller${page}x${i}`,
      }));
    const pages = [filler(1), filler(2), ITEMS];
    const total = pages.flat().length;
    fetchMock.mockImplementation(async (url: string) => {
      const page = Number(new URL(url, 'http://x').searchParams.get('page'));
      return { ok: true, json: async () => ({ items: pages[page - 1] ?? [], total }) };
    });

    const { result } = renderHook(() =>
      useUserVocabularyRegistration({ tenantId: 'tenant-hook', locale: 'de-DE', source: SOURCE }),
    );

    await waitFor(() => expect(result.current.scopes).toBeDefined());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const sizes = fetchMock.mock.calls.map((c) => new URL(String(c[0]), 'http://x').searchParams.get('pageSize'));
    expect(sizes).toEqual(Array(3).fill(String(VOCABULARY_LIST_MAX_PAGE_SIZE)));
    expect(result.current.vocabulary!.structs.map((m) => m.canonical)).toEqual(['Driver']);
  });

  it('stops on an empty page even if total over-reports', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const page = Number(new URL(url, 'http://x').searchParams.get('page'));
      return { ok: true, json: async () => ({ items: page === 1 ? ITEMS : [], total: 9999 }) };
    });

    const { result } = renderHook(() =>
      useUserVocabularyRegistration({ tenantId: 'tenant-hook', locale: 'de-DE', source: SOURCE }),
    );

    await waitFor(() => expect(result.current.scopes).toBeDefined());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stays idle when disabled', () => {
    renderHook(() =>
      useUserVocabularyRegistration({ tenantId: 'tenant-hook', locale: 'de-DE', source: SOURCE, enabled: false }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
