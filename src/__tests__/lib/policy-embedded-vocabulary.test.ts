// ADR 0060 §6 / 计划 T8：策略内嵌词汇的格式、确定性序列化、保存校验与合并优先级（内嵌 > 团队 > 作者）。
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DomainVocabulary, IdentifierMapping } from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';

// zh-CN 内置词法表目前没有官方别名；给它补一条，覆盖「写法等于官方别名」这一支。
vi.mock('@/lib/aster-lexicon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/aster-lexicon')>();
  return {
    ...actual,
    getLexicon: (locale: string) => {
      const lexicon = actual.getLexicon(locale);
      return locale === 'zh-CN' ? { ...lexicon, aliases: { RETURN: ['回到'] } } : lexicon;
    },
  };
});

import {
  EMBEDDED_VOCABULARY_LIMITS,
  EmbeddedVocabularyError,
  mergeEmbeddedVocabulary,
  parseEmbeddedVocabulary,
  serializeEmbeddedVocabulary,
  toDomainVocabulary,
  validateEmbeddedVocabulary,
  withEmbeddedVocabulary,
  type EmbeddedTerm,
  type EmbeddedVocabulary,
} from '@/lib/policy-embedded-vocabulary';
import { computeSourceEnvelope, vocabularyScopesJson } from '@/lib/policy-alias';

/** ADR §8 的《静夜思》内嵌词汇字面值。 */
const POEM_TEXT = '{"v":1,"terms":[{"kind":"literal","localized":"思故乡","canonical":"静夜思"},{"kind":"struct","localized":"望明月","canonical":"Text"}]}';
const POEM_ALIASES = { FUNC_PRODUCE: ['举头'], FUNC_TO: ['疑是'], MODULE_DECL: ['床前'], RETURN: ['低头'] };
const LITERAL: EmbeddedTerm = { kind: 'literal', localized: '思故乡', canonical: '静夜思' };
const STRUCT: EmbeddedTerm = { kind: 'struct', localized: '望明月', canonical: 'Text' };
const poem = (): EmbeddedVocabulary => ({ v: 1, terms: [LITERAL, STRUCT] });

interface EnvelopeVector {
  content: string;
  aliasSetJson: string;
  locale: string;
  toolchainId: string;
  vocabulary: DomainVocabulary | null;
  scopesJson: string;
  expectedSha256: string;
}
const VECTORS = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'lib', '__fixtures__', 'envelope-vectors.json'), 'utf8'),
) as EnvelopeVector[];
const LITERAL_MACRO = VECTORS.find((v) => v.vocabulary?.id === 'envelope.literal-macro')!;

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof EmbeddedVocabularyError) return err.code;
    throw err;
  }
  return undefined;
}

const validate = (terms: EmbeddedTerm[], aliasSet: Record<string, string[]> | null = null, locale = 'zh-CN') =>
  codeOf(() => validateEmbeddedVocabulary({ v: 1, terms }, { locale, aliasSet }));

function mapping(kind: string, localized: string, canonical: string, extra: Partial<IdentifierMapping> = {}): IdentifierMapping {
  return { kind, localized, canonical, ...extra } as IdentifierMapping;
}

function lowerVocabulary(parts: Partial<DomainVocabulary>, locale = 'zh-CN'): DomainVocabulary {
  return { id: 'user', name: 'user', locale, version: '1', structs: [], fields: [], functions: [], enumValues: [], ...parts };
}

const embeddedPoem = () => toDomainVocabulary(poem(), 'zh-CN');

describe('parseEmbeddedVocabulary / serializeEmbeddedVocabulary', () => {
  it('serializes deterministically regardless of input order and NFC form', () => {
    expect(serializeEmbeddedVocabulary({ v: 1, terms: [STRUCT, LITERAL] })).toBe(POEM_TEXT);
    expect(serializeEmbeddedVocabulary({ v: 1, terms: [LITERAL, STRUCT] })).toBe(POEM_TEXT);
    // 思故乡 没有分解形式；用组合字符验证 NFD 输入与 NFC 输入得到同一字节串
    const decomposed = serializeEmbeddedVocabulary({ v: 1, terms: [STRUCT, { kind: 'struct', localized: 'Cafe\u0301', canonical: 'Cafe' }] });
    const composed = serializeEmbeddedVocabulary({ v: 1, terms: [{ kind: 'struct', localized: 'Caf\u00e9', canonical: 'Cafe' }, STRUCT] });
    expect(decomposed).toBe(composed);
    expect(decomposed).toContain('"Caf\u00e9"');
  });

  it('sorts by (kind, localized, parent) in code point order and fixes the key order', () => {
    const text = serializeEmbeddedVocabulary({
      v: 1,
      terms: [
        { kind: 'field', localized: '乙', canonical: 'b', parent: 'Z' },
        { kind: 'field', localized: '乙', canonical: 'a', parent: 'A' },
        { kind: 'enum_value', localized: '甲', canonical: 'X', parent: 'E' },
      ],
    });
    expect(text).toBe(
      '{"v":1,"terms":[{"kind":"enum_value","localized":"甲","canonical":"X","parent":"E"},'
      + '{"kind":"field","localized":"乙","canonical":"a","parent":"A"},'
      + '{"kind":"field","localized":"乙","canonical":"b","parent":"Z"}]}',
    );
    // 增补平面字符（U+20000）按码点排在 U+FF21 之后，不按 UTF-16 码元
    const astral = serializeEmbeddedVocabulary({
      v: 1,
      terms: [
        { kind: 'struct', localized: '\u{20000}', canonical: 'B' },
        { kind: 'struct', localized: 'Ａ', canonical: 'A' },
      ],
    });
    expect(JSON.parse(astral!).terms.map((t: EmbeddedTerm) => t.canonical)).toEqual(['A', 'B']);
  });

  it('round-trips the ADR §8 literal value', () => {
    expect(serializeEmbeddedVocabulary(parseEmbeddedVocabulary(JSON.parse(POEM_TEXT)))).toBe(POEM_TEXT);
  });

  it('empty terms serialize to null', () => {
    expect(serializeEmbeddedVocabulary({ v: 1, terms: [] })).toBeNull();
  });

  it.each([
    ['not an object', []],
    ['wrong version', { v: 2, terms: [] }],
    ['unknown top-level key', { v: 1, terms: [], extra: 1 }],
    ['terms not an array', { v: 1, terms: {} }],
    ['unknown term key', { v: 1, terms: [{ ...STRUCT, aliases: ['x'] }] }],
    ['unknown kind', { v: 1, terms: [{ kind: 'macro', localized: 'a', canonical: 'b' }] }],
    ['missing parent on field', { v: 1, terms: [{ kind: 'field', localized: 'a', canonical: 'b' }] }],
    ['parent on struct', { v: 1, terms: [{ ...STRUCT, parent: 'X' }] }],
    ['parent on literal', { v: 1, terms: [{ ...LITERAL, parent: 'X' }] }],
    ['null parent on enum_value', { v: 1, terms: [{ kind: 'enum_value', localized: 'a', canonical: 'B', parent: null }] }],
    ['non-string canonical', { v: 1, terms: [{ kind: 'struct', localized: 'a', canonical: 1 }] }],
    ['non-string localized', { v: 1, terms: [{ kind: 'struct', localized: null, canonical: 'A' }] }],
  ])('rejects %s → embedded_vocabulary_invalid_format', (_name, input) => {
    expect(codeOf(() => parseEmbeddedVocabulary(input))).toBe('embedded_vocabulary_invalid_format');
  });
});

describe('validateEmbeddedVocabulary', () => {
  it('accepts the poem vocabulary with the poem aliases', () => {
    expect(validate(poem().terms, POEM_ALIASES)).toBeUndefined();
  });

  it('enforces every limit → embedded_vocabulary_too_large', () => {
    const L = EMBEDDED_VOCABULARY_LIMITS;
    const many = Array.from({ length: L.maxTerms + 1 }, (_, i) => ({ kind: 'struct' as const, localized: `词${i}`, canonical: `T${i}` }));
    expect(validate(many)).toBe('embedded_vocabulary_too_large');
    expect(validate(many.slice(0, L.maxTerms))).toBeUndefined();
    expect(validate([{ kind: 'struct', localized: '字'.repeat(L.maxLocalized + 1), canonical: 'T' }])).toBe('embedded_vocabulary_too_large');
    expect(validate([{ kind: 'struct', localized: '字'.repeat(L.maxLocalized), canonical: 'T' }])).toBeUndefined();
    expect(validate([{ kind: 'struct', localized: '字', canonical: 'T'.repeat(L.maxCanonical + 1) }])).toBe('embedded_vocabulary_too_large');
    expect(validate([{ kind: 'field', localized: '字', canonical: 'f', parent: 'P'.repeat(L.maxCanonical + 1) }])).toBe('embedded_vocabulary_too_large');
    expect(validate([{ kind: 'literal', localized: '字', canonical: '文'.repeat(L.maxLiteral + 1) }])).toBe('embedded_vocabulary_too_large');
    expect(validate([{ kind: 'literal', localized: '字', canonical: '文'.repeat(L.maxLiteral) }])).toBeUndefined();
  });

  it('enforces the serialized byte limit (8193 bytes rejected, 8192 accepted)', () => {
    // 32 条、每条都在单项上限内的字面量，凑出指定的序列化字节数：前 31 条固定，最后一条补齐
    const fixed = Array.from({ length: 31 }, (_, i) => ({ kind: 'literal' as const, localized: `t${String(i).padStart(2, '0')}`, canonical: 'y'.repeat(210) }));
    const bytes = (terms: EmbeddedTerm[]) => new TextEncoder().encode(serializeEmbeddedVocabulary({ v: 1, terms })!).length;
    const head = bytes([...fixed, { kind: 'literal', localized: 'zz', canonical: '' }]);
    const sized = (total: number): EmbeddedTerm[] => [...fixed, { kind: 'literal', localized: 'zz', canonical: 'y'.repeat(total - head) }];
    expect(bytes(sized(8193))).toBe(8193);
    expect(validate(sized(8193), null, 'en-US')).toBe('embedded_vocabulary_too_large');
    expect(validate(sized(8192), null, 'en-US')).toBeUndefined();
  });

  it('rejects a literal containing a quote or a newline → embedded_vocabulary_invalid', () => {
    expect(validate([{ kind: 'literal', localized: '甲', canonical: '有"引号' }])).toBe('embedded_vocabulary_invalid');
    expect(validate([{ kind: 'literal', localized: '甲', canonical: '换\n行' }])).toBe('embedded_vocabulary_invalid');
    expect(validate([{ kind: 'literal', localized: '甲', canonical: '' }])).toBe('embedded_vocabulary_invalid');
  });

  it('rejects a non-ASCII canonical for struct → embedded_vocabulary_invalid', () => {
    expect(validate([{ kind: 'struct', localized: '月', canonical: '月亮' }])).toBe('embedded_vocabulary_invalid');
    expect(validate([{ kind: 'struct', localized: ' ', canonical: 'Moon' }])).toBe('embedded_vocabulary_invalid');
  });

  it('rejects two terms with the same role key, and a duplicate trigger → embedded_vocabulary_duplicate', () => {
    expect(validate([STRUCT, { ...STRUCT, canonical: 'Moon' }])).toBe('embedded_vocabulary_duplicate');
    expect(validate([
      { kind: 'field', localized: '甲', canonical: 'a', parent: 'P' },
      { kind: 'field', localized: '甲', canonical: 'b', parent: 'P' },
    ])).toBe('embedded_vocabulary_duplicate');
    // 不同 parent 的同名字段是不同角色键
    expect(validate([
      { kind: 'field', localized: '甲', canonical: 'a', parent: 'P' },
      { kind: 'field', localized: '甲', canonical: 'a', parent: 'Q' },
    ])).toBeUndefined();
    expect(validate([LITERAL, { ...LITERAL, canonical: '别的' }])).toBe('embedded_vocabulary_duplicate');
    // 字面量触发词与任何角色的写法同形也算重复（大小写折叠）
    expect(validate([LITERAL, { kind: 'function', localized: '思故乡', canonical: 'f' }])).toBe('embedded_vocabulary_duplicate');
    expect(validate([
      { kind: 'literal', localized: 'Hello', canonical: 'x' },
      { kind: 'struct', localized: 'hello', canonical: 'H' },
    ], null, 'en-US')).toBe('embedded_vocabulary_duplicate');
    // 非字面量在不同角色同形是允许的（引擎按位置区分）
    expect(validate([STRUCT, { kind: 'function', localized: '望明月', canonical: 'look' }])).toBeUndefined();
  });

  it('rejects a written form equal to 返回, to a base alias, or to an alias in the version aliasSet → embedded_vocabulary_shadows_keyword', () => {
    expect(validate([{ kind: 'struct', localized: '返回', canonical: 'R' }])).toBe('embedded_vocabulary_shadows_keyword');
    expect(validate([{ kind: 'literal', localized: '回到', canonical: '文' }])).toBe('embedded_vocabulary_shadows_keyword');
    expect(validate([{ kind: 'struct', localized: '低头', canonical: 'R' }], POEM_ALIASES)).toBe('embedded_vocabulary_shadows_keyword');
    expect(validate([{ kind: 'struct', localized: '低头', canonical: 'R' }], null)).toBeUndefined();
    expect(validate([{ kind: 'struct', localized: 'Return', canonical: 'R' }], null, 'en-US')).toBe('embedded_vocabulary_shadows_keyword');
  });

  it('reports the first problem in §6.4 order (too_large before duplicate before invalid)', () => {
    const big = { kind: 'struct' as const, localized: '字'.repeat(40), canonical: '月亮' };
    expect(validate([big, { ...big }])).toBe('embedded_vocabulary_too_large');
    expect(validate([{ kind: 'struct', localized: '甲', canonical: '月亮' }, { kind: 'struct', localized: '甲', canonical: '月亮' }]))
      .toBe('embedded_vocabulary_duplicate');
    expect(validate([{ kind: 'struct', localized: '返回', canonical: '月亮' }])).toBe('embedded_vocabulary_invalid');
  });
});

describe('toDomainVocabulary', () => {
  it('builds the engine shape with a fixed id and the policy locale', () => {
    expect(embeddedPoem()).toEqual({
      id: 'policy.embedded',
      name: 'policy',
      locale: 'zh-CN',
      version: '1',
      structs: [{ kind: 'struct', localized: '望明月', canonical: 'Text' }],
      fields: [],
      functions: [],
      enumValues: [],
      literals: [{ kind: 'literal', localized: '思故乡', canonical: '静夜思' }],
    });
  });

  it('vocabularyScopesJson of the poem vocabulary equals the envelope.literal-macro vector scopesJson', () => {
    expect(LITERAL_MACRO).toBeDefined();
    const scopes = vocabularyScopesJson(embeddedPoem());
    expect(scopes).toBe(LITERAL_MACRO.scopesJson);
    expect(computeSourceEnvelope(LITERAL_MACRO.content, LITERAL_MACRO.aliasSetJson, 'zh-CN', LITERAL_MACRO.toolchainId, scopes))
      .toBe(LITERAL_MACRO.expectedSha256);
  });
});

describe('mergeEmbeddedVocabulary：内嵌 > 团队 > 作者', () => {
  it('embedded term shadows a later author term', () => {
    const moon = mapping('struct', '望明月', 'Moon');
    const { vocabulary, shadowed } = mergeEmbeddedVocabulary(embeddedPoem(), lowerVocabulary({ structs: [moon] }));
    expect(vocabulary!.structs).toEqual([{ kind: 'struct', localized: '望明月', canonical: 'Text' }]);
    expect(vocabulary!.literals).toEqual([{ kind: 'literal', localized: '思故乡', canonical: '静夜思' }]);
    expect(shadowed).toEqual([{ kind: 'struct', localized: '望明月', canonical: 'Moon', source: 'author' }]);
    expect(vocabulary!.locale).toBe('zh-CN');
  });

  it('a team term reported as team when the caller labels its source', () => {
    const moon = mapping('struct', '望明月', 'Moon');
    const sources = new Map([[moon, 'team' as const]]);
    const { shadowed } = mergeEmbeddedVocabulary(embeddedPoem(), lowerVocabulary({ structs: [moon] }), sources);
    expect(shadowed).toEqual([{ kind: 'struct', localized: '望明月', canonical: 'Moon', source: 'team' }]);
  });

  it('an embedded literal trigger drops a lower term of any role with the same written form', () => {
    const lower = lowerVocabulary({
      structs: [mapping('struct', '思故乡', 'Home')],
      fields: [mapping('field', '思故乡', 'home', { parent: 'Text' })],
      functions: [mapping('function', '思故乡', 'miss')],
      enumValues: [mapping('enum_value', '思故乡', 'HOME', { parent: 'Mood' })],
      // 别名命中同样整条丢弃
      literals: [],
    });
    const aliased = mapping('struct', '故里', 'Hometown', { aliases: ['思故乡'] });
    const { vocabulary, shadowed } = mergeEmbeddedVocabulary(embeddedPoem(), { ...lower, structs: [...lower.structs, aliased] });
    expect(shadowed.map((s) => `${s.kind}:${s.canonical}`).sort()).toEqual(
      ['enum_value:HOME', 'field:home', 'function:miss', 'struct:Home', 'struct:Hometown'],
    );
    expect(vocabulary!.structs).toEqual([{ kind: 'struct', localized: '望明月', canonical: 'Text' }]);
    expect(vocabulary!.fields).toEqual([]);
    expect(vocabulary!.functions).toEqual([]);
    expect(vocabulary!.enumValues).toEqual([]);
  });

  it('a lower literal whose trigger equals an embedded written form is dropped; an identical literal is deduplicated', () => {
    const clash = mapping('literal', '望明月', '月光');
    const other = mapping('literal', '思故乡', '别的');
    const same = mapping('literal', '思故乡', '静夜思');
    const clashResult = mergeEmbeddedVocabulary(embeddedPoem(), lowerVocabulary({ literals: [clash, other] }));
    expect(clashResult.shadowed.map((s) => s.canonical).sort()).toEqual(['别的', '月光']);
    expect(clashResult.vocabulary!.literals).toEqual([{ kind: 'literal', localized: '思故乡', canonical: '静夜思' }]);
    const sameResult = mergeEmbeddedVocabulary(embeddedPoem(), lowerVocabulary({ literals: [same] }));
    expect(sameResult.shadowed).toEqual([]);
    expect(sameResult.vocabulary!.literals).toEqual([{ kind: 'literal', localized: '思故乡', canonical: '静夜思' }]);
  });

  it('literal clashes fold case like the engine trigger check; role keys do not', () => {
    const embedded = toDomainVocabulary({ v: 1, terms: [
      { kind: 'literal', localized: 'greeting', canonical: 'Hello' },
      { kind: 'struct', localized: 'Moon', canonical: 'Moon' },
    ] }, 'en-US');
    const lower = lowerVocabulary({
      structs: [mapping('struct', 'Greeting', 'Greet'), mapping('struct', 'moon', 'Luna')],
    }, 'en-US');
    const { vocabulary, shadowed } = mergeEmbeddedVocabulary(embedded, lower);
    expect(shadowed.map((s) => s.canonical)).toEqual(['Greet']);
    expect(vocabulary!.structs.map((s) => s.canonical).sort()).toEqual(['Luna', 'Moon']);
  });

  it('identical lower term is deduplicated, not reported', () => {
    const { vocabulary, shadowed } = mergeEmbeddedVocabulary(
      embeddedPoem(),
      lowerVocabulary({ structs: [mapping('struct', '望明月', 'Text')] }),
    );
    expect(shadowed).toEqual([]);
    expect(vocabulary!.structs).toEqual([{ kind: 'struct', localized: '望明月', canonical: 'Text' }]);
  });

  it('keeps unrelated lower terms, and a different role with the same written form', () => {
    const keep = [mapping('struct', '明月', 'Moon')];
    const field = mapping('field', '望明月', 'gaze', { parent: 'Person' });
    const { vocabulary, shadowed } = mergeEmbeddedVocabulary(embeddedPoem(), lowerVocabulary({ structs: keep, fields: [field] }));
    expect(shadowed).toEqual([]);
    expect(vocabulary!.structs.map((s) => s.canonical).sort()).toEqual(['Moon', 'Text']);
    expect(vocabulary!.fields).toEqual([field]);
  });

  it('no embedded terms returns the lower vocabulary object unchanged; no lower returns the embedded vocabulary', () => {
    const lower = lowerVocabulary({ structs: [mapping('struct', '望明月', 'Moon')] });
    expect(mergeEmbeddedVocabulary(null, lower).vocabulary).toBe(lower);
    expect(mergeEmbeddedVocabulary(toDomainVocabulary({ v: 1, terms: [] }, 'zh-CN'), lower).vocabulary).toBe(lower);
    expect(mergeEmbeddedVocabulary(embeddedPoem(), null)).toEqual({ vocabulary: embeddedPoem(), shadowed: [] });
  });
});

describe('withEmbeddedVocabulary（读路径）', () => {
  it('versions without embedded vocabulary: lower vocabulary is returned as-is, so every envelope vector is unchanged', () => {
    for (const v of VECTORS) {
      for (const text of [null, undefined]) {
        const effective = withEmbeddedVocabulary(v.vocabulary, text, v.locale);
        expect(effective).toBe(v.vocabulary);
        const scopes = vocabularyScopesJson(effective);
        expect(scopes).toBe(v.scopesJson);
        expect(computeSourceEnvelope(v.content, v.aliasSetJson, v.locale, v.toolchainId, scopes)).toBe(v.expectedSha256);
      }
    }
  });

  it('merges the stored poem text with the lower vocabulary', () => {
    const effective = withEmbeddedVocabulary(lowerVocabulary({ structs: [mapping('struct', '望明月', 'Moon')] }), POEM_TEXT, 'zh-CN');
    expect(vocabularyScopesJson(effective)).toBe(LITERAL_MACRO.scopesJson);
    expect(vocabularyScopesJson(withEmbeddedVocabulary(null, POEM_TEXT, 'zh-CN'))).toBe(LITERAL_MACRO.scopesJson);
  });

  it.each([
    ['not JSON', '{"v":1,'],
    // 无内嵌词条只存 NULL；空串不是任何规范序列化
    ['empty', ''],
    ['wrong shape', '{"v":1,"terms":[{"kind":"macro","localized":"a","canonical":"b"}]}'],
    ['not canonical (whitespace)', POEM_TEXT.replace('"terms":', '"terms": ')],
    ['not canonical (order)', '{"v":1,"terms":[{"kind":"struct","localized":"望明月","canonical":"Text"},{"kind":"literal","localized":"思故乡","canonical":"静夜思"}]}'],
  ])('stored text that is %s throws instead of degrading', (_name, text) => {
    expect(codeOf(() => withEmbeddedVocabulary(null, text, 'zh-CN'))).toBe('embedded_vocabulary_invalid_format');
  });
});
