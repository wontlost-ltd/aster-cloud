/**
 * useUserVocabularyRegistration（#602 线B）：编辑器按源码注册作用域内的用户词汇。
 *
 * 覆盖生产缺陷：策略编辑器从未拉取用户词汇。现在开启后应：
 *   - 拉取全部词条（不按 domain/locale 过滤，`de` 词条适用于 de-DE 编译器）；
 *   - 只把源码引用的同语言分组合并注册到 USER_VOCABULARY_DOMAIN；
 *   - 源码不再引用用户词时撤销注册。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@/hooks/useDomainVocabularyInvalidate', () => ({
  useDomainVocabularyInvalidate: () => 0,
}));

import { useUserVocabularyRegistration } from '@/hooks/useUserVocabularyRegistration';
import { vocabularyRegistry } from '@/lib/aster-lexicon';
import { USER_VOCABULARY_DOMAIN } from '@/lib/domain-vocabulary-scope';

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
    vocabularyRegistry.unregisterCustom('tenant-hook', USER_VOCABULARY_DOMAIN, 'de-DE');
  });

  it('registers only the in-scope groups under the editor domain', async () => {
    const { result } = renderHook(() =>
      useUserVocabularyRegistration({ tenantId: 'tenant-hook', locale: 'de-DE', source: SOURCE }),
    );

    await waitFor(() => expect(result.current.domain).toBe(USER_VOCABULARY_DOMAIN));
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).not.toContain('domain=');
    expect(url).not.toContain('locale=');
    expect(result.current.vocabulary!.structs.map((m) => m.canonical)).toEqual(['Driver']);

    const registered = vocabularyRegistry.getWithCustom('tenant-hook', USER_VOCABULARY_DOMAIN, 'de-DE');
    expect(registered?.vocabulary.fields.map((m) => m.canonical)).toEqual(['age']);
  });

  it('unregisters when the source no longer uses any user term', async () => {
    const { result, rerender } = renderHook(
      ({ source }) => useUserVocabularyRegistration({ tenantId: 'tenant-hook', locale: 'de-DE', source }),
      { initialProps: { source: SOURCE } },
    );
    await waitFor(() => expect(result.current.domain).toBe(USER_VOCABULARY_DOMAIN));

    rerender({ source: 'Definiere Auto hat preis als Ganzzahl.' });

    await waitFor(() => expect(result.current.domain).toBeUndefined());
    expect(vocabularyRegistry.getWithCustom('tenant-hook', USER_VOCABULARY_DOMAIN, 'de-DE')).toBeUndefined();
  });

  it('stays idle when disabled', () => {
    renderHook(() =>
      useUserVocabularyRegistration({ tenantId: 'tenant-hook', locale: 'de-DE', source: SOURCE, enabled: false }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
