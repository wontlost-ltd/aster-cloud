// ADR 0060 §5.3、§6.4 / 计划 T9：别名占用集取本次保存的有效词汇（下层 + 内嵌），含字面量触发词。
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({ structuralAliasGrants: {} }));
vi.mock('@/db/fresh-read', () => ({ freshDb: {} }));

import { IdentifierKind, type DomainVocabulary } from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';
import { buildAliasReservedFromVocabulary } from '@/lib/structural-alias-grants';
import { extractReservedAliasSets, getLexicon } from '@/lib/aster-lexicon';
import { mergeEmbeddedVocabulary, toDomainVocabulary } from '@/lib/policy-embedded-vocabulary';
import { validateUserAliases } from '@/lib/policy-alias-shared';

const POEM = toDomainVocabulary({
  v: 1,
  terms: [
    { kind: 'literal', localized: '思故乡', canonical: '静夜思' },
    { kind: 'struct', localized: '望明月', canonical: 'Text' },
  ],
}, 'zh-CN');

describe('buildAliasReservedFromVocabulary', () => {
  it('alias reserved set contains embedded literal triggers and struct forms, not literal contents', () => {
    const reserved = buildAliasReservedFromVocabulary('zh-CN', POEM).vocabularyTermsLower!;
    expect([...reserved].sort()).toEqual(['text', '思故乡', '望明月'].sort());
    expect(reserved.has('静夜思')).toBe(false);
  });

  it('includes localized forms, aliases and canonical names of every role, normalized', () => {
    const lower: DomainVocabulary = {
      id: 'd', name: 'd', locale: 'en-US', version: '1',
      structs: [{ canonical: 'Driver', localized: 'Motorist', kind: IdentifierKind.STRUCT, aliases: ['Road  User'] }],
      fields: [{ canonical: 'age', localized: 'Years Old', kind: IdentifierKind.FIELD, parent: 'Driver' }],
      functions: [{ canonical: 'score', localized: 'Rate', kind: IdentifierKind.FUNCTION }],
      enumValues: [{ canonical: 'High', localized: 'Top', kind: IdentifierKind.ENUM_VALUE, parent: 'Level' }],
    };
    const reserved = buildAliasReservedFromVocabulary('en-US', lower).vocabularyTermsLower!;
    expect([...reserved].sort()).toEqual(['age', 'driver', 'high', 'motorist', 'rate', 'road user', 'score', 'top', 'years old'].sort());
  });

  it('keeps the base lexicon sets and is empty for a null vocabulary', () => {
    const reserved = buildAliasReservedFromVocabulary('en-US', null);
    const base = extractReservedAliasSets(getLexicon('en-US'));
    expect(reserved.canonicalKeywordsLower).toEqual(base.canonicalKeywordsLower);
    expect(reserved.baseAliasesLower).toEqual(base.baseAliasesLower);
    expect(reserved.vocabularyTermsLower!.size).toBe(0);
  });

  it('an alias equal to a written form of the merged vocabulary collides; a shadowed lower form does not', () => {
    const lower: DomainVocabulary = {
      id: 'd', name: 'd', locale: 'en-US', version: '1',
      structs: [{ canonical: 'Moon', localized: 'full moon', kind: IdentifierKind.STRUCT }],
      fields: [], functions: [], enumValues: [],
    };
    const embedded = toDomainVocabulary({ v: 1, terms: [{ kind: 'literal', localized: 'full moon', canonical: 'night' }] }, 'en-US');
    const merged = mergeEmbeddedVocabulary(embedded, lower).vocabulary;
    const reserved = buildAliasReservedFromVocabulary('en-US', merged);
    // full moon 是内嵌字面量触发词，别名不得同形
    expect(validateUserAliases({ TIMES: ['full moon'] }, reserved).valid).toBe(false);
    // 被遮蔽的下层词条（规范名 Moon）不再参与编译，也不再占用
    expect(reserved.vocabularyTermsLower!.has('moon')).toBe(false);
  });
});
