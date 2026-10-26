/**
 * 领域词汇作用域（#602 / #610）。
 *
 * 复现 2026-10-26 生产用例：用户在 e2e1026/de 下建了 Driver→Fahrer、age→alter，另有
 * 无关的 e2etest/en、非法 locale 与大写 domain 分组。德语策略用 Fahrer/alter 编写后：
 *   - 作用域只含 e2e1026/de（与 de-DE 主语言相同且被源码引用）；
 *   - 用编辑器同款注册方式（合并词汇 + USER_VOCABULARY_DOMAIN）编译，规范字段名输入
 *     {"person":{"age":21}} 执行得 42。
 * 注意：两个引擎的术语翻译都大小写不敏感，参数名若写成 `fahrer` 会被翻成 `Driver`，
 * 故这里参数取 `person`（执行路由层的回归见 policy-execute-vocabulary 测试）。
 */
import { describe, expect, it } from 'vitest';
import { compile, evaluate } from '@aster-cloud/aster-lang-ts/browser';
import { DE_DE, vocabularyRegistry, initBuiltinVocabularies } from '@/lib/aster-lexicon';
import {
  USER_VOCABULARY_DOMAIN,
  isLocaleCompatible,
  isVocabularyUsedBy,
  mergeVocabularies,
  resolvePolicyVocabularyFromRows,
} from '@/lib/domain-vocabulary-scope';
import { assembleDomainVocabularyFromLinks, type TermLikeRow } from '@/lib/domain-vocabulary-assemble';

function row(
  id: string,
  domain: string,
  locale: string,
  kind: string,
  canonical: string,
  localized: string,
  parentCanonical: string | null = null,
): TermLikeRow {
  return { domainTermId: id, domain, locale, kind, canonical, localized, parentCanonical };
}

const PROD_ROWS: TermLikeRow[] = [
  row('t-driver', 'e2e1026', 'de', 'struct', 'Driver', 'Fahrer'),
  row('t-age', 'e2e1026', 'de', 'field', 'age', 'alter', 'Driver'),
  row('t-bad', 'e2e1026', 'xx_INVALID!!', 'struct', 'Licensed', 'Fahrer'),
  row('t-app', 'e2etest', 'en', 'struct', 'Applicant', 'Fahrer'),
  row('t-unused', 'insurance', 'de', 'struct', 'Policy', 'Versicherung'),
];

const DE_POLICY = `Modul e2e1026.vocab.

Definiere Fahrer hat alter als Ganzzahl.

Regel bewerten gegeben person als Fahrer liefert Ganzzahl:
  wenn person.alter mindestens 18:
    gib zurück 42.
  gib zurück 0.
`;

describe('isLocaleCompatible', () => {
  it('matches on the primary language subtag, case-insensitively', () => {
    expect(isLocaleCompatible('de', 'de-DE')).toBe(true);
    expect(isLocaleCompatible('DE_at', 'de-DE')).toBe(true);
    expect(isLocaleCompatible('en', 'de-DE')).toBe(false);
    expect(isLocaleCompatible('xx_INVALID!!', 'de-DE')).toBe(false);
    expect(isLocaleCompatible('', 'de-DE')).toBe(false);
  });
});

describe('isVocabularyUsedBy', () => {
  const vocab = (localized: string, aliases?: string[]) =>
    assembleDomainVocabularyFromLinks([{ ...row('x', 'd', 'de', 'field', 'age', localized), aliases }]);

  it('matches whole words only, case-insensitively', () => {
    expect(isVocabularyUsedBy('wenn fahrer.alter mindestens 18', vocab('alter'))).toBe(true);
    expect(isVocabularyUsedBy('Definiere X hat Alter.', vocab('alter'))).toBe(true);
    expect(isVocabularyUsedBy('wenn fahrer.altersgrenze', vocab('alter'))).toBe(false);
  });

  it('matches aliases and CJK substrings', () => {
    expect(isVocabularyUsedBy('x.lebensalter', vocab('alter', ['lebensalter']))).toBe(true);
    expect(isVocabularyUsedBy('如果 驾驶员年龄 至少 18', vocab('驾驶员'))).toBe(true);
  });
});

describe('resolvePolicyVocabularyFromRows', () => {
  it('selects only the same-language groups the source references', () => {
    const vocab = resolvePolicyVocabularyFromRows(PROD_ROWS, { source: DE_POLICY, locale: 'de-DE' });
    expect(vocab).not.toBeNull();
    expect(vocab!.id).toBe('e2e1026');
    expect(vocab!.locale).toBe('de-DE');
    expect(vocab!.structs.map((m) => m.canonical)).toEqual(['Driver']);
    expect(vocab!.fields.map((m) => m.canonical)).toEqual(['age']);
  });

  it('returns null when the source uses no user term', () => {
    const source = 'Rule r given age as Int, produce Int: Return age.';
    expect(resolvePolicyVocabularyFromRows(PROD_ROWS, { source, locale: 'en-US' })).toBeNull();
  });
});

describe('mergeVocabularies', () => {
  it('dedupes identical mappings across groups', () => {
    const a = assembleDomainVocabularyFromLinks([row('1', 'a', 'de', 'struct', 'Driver', 'Fahrer')]);
    const b = assembleDomainVocabularyFromLinks([
      row('2', 'b', 'de', 'struct', 'Driver', 'Fahrer'),
      row('3', 'b', 'de', 'struct', 'Car', 'Auto'),
    ]);
    const merged = mergeVocabularies([a, b], { id: 'm', locale: 'de-DE' })!;
    expect(merged.id).toBe('m');
    expect(merged.structs.map((m) => m.canonical)).toEqual(['Driver', 'Car']);
  });
});

describe('prod regression: de policy with Fahrer/alter executes with canonical input', () => {
  it('compiles with the editor-scoped vocabulary and returns 42 for canonical input', () => {
    initBuiltinVocabularies();
    const tenantId = 'tenant-scope-test';
    const vocab = resolvePolicyVocabularyFromRows(
      PROD_ROWS,
      { source: DE_POLICY, locale: 'de-DE' },
      { id: USER_VOCABULARY_DOMAIN },
    )!;
    vocabularyRegistry.registerCustom(tenantId, vocab);

    const result = compile(DE_POLICY, {
      lexicon: DE_DE,
      domain: USER_VOCABULARY_DOMAIN,
      tenantId,
    } as Parameters<typeof compile>[1]);
    const diagnostics = (result as { diagnostics?: { severity?: string }[] }).diagnostics ?? [];
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors, JSON.stringify(errors)).toEqual([]);
    expect(result.core).toBeTruthy();

    const run = evaluate(result.core!, 'bewerten', { person: { age: 21 } });
    expect(run.error ?? null).toBeNull();
    expect(run.value).toBe(42);
  });

  it('without the vocabulary the canonical input does not reach the localized field', () => {
    const result = compile(DE_POLICY, { lexicon: DE_DE } as Parameters<typeof compile>[1]);
    expect(result.core).toBeTruthy();
    const run = evaluate(result.core!, 'bewerten', { person: { age: 21 } });
    expect(run.value).not.toBe(42);
  });
});
