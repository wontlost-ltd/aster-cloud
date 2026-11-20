/**
 * 「静夜思」特色模板（ADR 0060 §8，cloud#830）：原诗即源码，按真实策略的保存口径校验。
 *
 * - 源码与演示 /zh/demos/poem 的 POEM_ZH.source 逐字节相同；
 * - aliasSet：别名规则 v2，占用集与服务端保存同源（zh-CN 词法表 + 本策略内嵌词汇），有结构词授权才合法；
 * - 内嵌词汇：保存校验通过，规范序列化等于 ADR 的值；
 * - 编译：zh-CN + aliasSet + 内嵌词汇齐备才零诊断，Core IR 的 positionFreeSha256 与 ts / core 两侧证明相同；
 * - 执行：入口「地上霜」求值为「静夜思」；
 * - 排版：通过 validatePolicyLayout，toDisplay 与原诗一字不差。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({ structuralAliasGrants: {} }));
vi.mock('@/db/fresh-read', () => ({ freshDb: {} }));

import { compileAndTypecheck, evaluate } from '@aster-cloud/aster-lang-ts/browser';
import { toCanonical, toDisplay, validatePolicyLayout } from '@aster-cloud/aster-lang-ts/layout';
import { CompileFailure, compileSourcePositionFreeSha256 } from '@aster-cloud/aster-lang-ts/package-check';
import { POEMS } from '@/config/poem-demo';
import { jingyesiShowcaseExample as tpl } from '@/data/policy-example-showcase';
import {
  POLICY_EXAMPLES,
  findExampleDefaultInput,
  getExampleLocales,
  getExampleSource,
  hasTemplateExtras,
  isTemplateAvailable,
} from '@/data/policy-examples';
import { getLexicon, withUserAliases } from '@/lib/aster-lexicon';
import { canonicalAliasJson, validateUserAliases, type AliasSet } from '@/lib/policy-alias-shared';
import {
  serializeEmbeddedVocabulary,
  toDomainVocabulary,
  validateEmbeddedVocabulary,
} from '@/lib/policy-embedded-vocabulary';
import { buildAliasReservedFromVocabulary } from '@/lib/structural-alias-grants';

const ZH = 'zh-CN';
const source = getExampleSource(tpl, 'en-US');
const aliasSet: Record<string, string[]> = Object.fromEntries(Object.entries(tpl.aliasSet ?? {}).map(([k, v]) => [k, [...v]]));
const vocabulary = toDomainVocabulary(tpl.embeddedVocabulary!, ZH);
const zh = getLexicon(ZH);

/** ADR 0060 §8 的两项编译输入（规范序列化）。 */
const ADR_ALIAS_SET = '{"FUNC_PRODUCE":["举头"],"FUNC_TO":["疑是"],"MODULE_DECL":["床前"],"RETURN":["低头"]}';
const ADR_EMBEDDED =
  '{"v":1,"terms":[{"kind":"literal","localized":"思故乡","canonical":"静夜思"},{"kind":"struct","localized":"望明月","canonical":"Text"}]}';
/** ts `jingyesi-policy.test.ts`、core `JingyesiPolicyTest`、aster-api `JingyesiPolicyCompileTest` 与 cloud 对拍测试的同一值。 */
const JINGYESI_POSITION_FREE_SHA256 = '55512170231ae56d7f01b8130ce368d650c5b390ad6f0ac7f34d5350c8960ec6';
const POEM_LINES = '床前明月光，疑是地上霜。举头望明月，低头思故乡。';

function errorsOf(result: ReturnType<typeof compileAndTypecheck>): string[] {
  return [
    ...(result.parseErrors ?? []).map((e) => (typeof e === 'object' && e && 'message' in e ? String(e.message) : String(e))),
    ...(result.resolutionDiagnostics ?? []).map((d) => `${d.code}: ${d.message}`),
    ...(result.typeErrors ?? []).map((e) => e.message),
  ];
}

/** 与 Node 包导出前重编译同一入口（含别名校验与名字守卫）：返回 positionFreeSha256。 */
function positionFreeSha(opts: { aliases?: AliasSet | null; allowStructural?: boolean; withVocabulary?: boolean }): string {
  return compileSourcePositionFreeSha256(source, {
    locale: ZH,
    aliasSetJson: canonicalAliasJson(opts.aliases === undefined ? aliasSet : opts.aliases ?? {}) ?? 'null',
    allowStructural: opts.allowStructural ?? true,
    ...((opts.withVocabulary ?? true) ? { vocabularyJson: JSON.stringify(vocabulary) } : {}),
  });
}

describe('showcase template: the original Jingyesi poem (ADR 0060 §8)', () => {
  it('is in the catalog, pinned to zh-CN, with the same source for every UI locale', () => {
    expect(POLICY_EXAMPLES).toContain(tpl);
    expect(tpl.id).toBe('showcase-jingyesi');
    expect(tpl.cnlLocale).toBe(ZH);
    expect(getExampleLocales(tpl)).toEqual([ZH]);
    for (const locale of ['en-US', 'zh-CN', 'de-DE'] as const) expect(getExampleSource(tpl, locale)).toBe(source);
    expect(hasTemplateExtras(tpl)).toBe(true);
  });

  it('source is the original poem, byte-identical to the demo', () => {
    expect(source).toBe(POEMS.zh.source);
    expect(source).toBe('床前 明月光。\n疑是 地上霜，举头 望明月：\n  低头 思故乡。\n');
  });

  it('requires structured authoring and the structural alias grant, and is locked without either', () => {
    expect(tpl.requires).toEqual({ structuredAuthoring: true, structuralAliases: true });
    expect(isTemplateAvailable(tpl, { structuredAuthoring: true, structuralAliases: true })).toBe(true);
    expect(isTemplateAvailable(tpl, { structuredAuthoring: true, structuralAliases: false })).toBe(false);
    expect(isTemplateAvailable(tpl, { structuredAuthoring: false, structuralAliases: true })).toBe(false);
    expect(isTemplateAvailable(tpl, { structuredAuthoring: false, structuralAliases: false })).toBe(false);
  });

  it('aliasSet is the ADR value and passes validateUserAliases v2 for zh-CN with the grant, and fails without it', () => {
    expect(canonicalAliasJson(aliasSet)).toBe(ADR_ALIAS_SET);
    const reserved = buildAliasReservedFromVocabulary(ZH, vocabulary);
    expect(validateUserAliases(aliasSet, reserved, { allowStructural: true, locale: ZH })).toEqual({ valid: true, errors: [], issues: [] });
    const ungranted = validateUserAliases(aliasSet, reserved, { allowStructural: false, locale: ZH });
    expect(ungranted.valid).toBe(false);
    expect(new Set(ungranted.issues.map((i) => i.code))).toEqual(new Set(['structuralNotGranted']));
    expect(ungranted.issues.map((i) => i.kind).sort()).toEqual(['FUNC_PRODUCE', 'FUNC_TO', 'MODULE_DECL', 'RETURN']);
  });

  it('embedded vocabulary is valid and serializes to the ADR value (a type term and a literal macro)', () => {
    expect(() => validateEmbeddedVocabulary(tpl.embeddedVocabulary!, { locale: ZH, aliasSet })).not.toThrow();
    expect(serializeEmbeddedVocabulary(tpl.embeddedVocabulary!)).toBe(ADR_EMBEDDED);
    expect(vocabulary.literals).toEqual([{ localized: '思故乡', canonical: '静夜思', kind: 'literal' }]);
    expect(vocabulary.structs).toEqual([{ localized: '望明月', canonical: 'Text', kind: 'struct' }]);
  });

  it('compiles with zh-CN plus aliasSet plus embedded vocabulary, and fails if either is removed', () => {
    const lexicon = withUserAliases(zh, aliasSet);
    expect(errorsOf(compileAndTypecheck(source, { lexicon, vocabulary }))).toEqual([]);
    expect(errorsOf(compileAndTypecheck(source, { lexicon: zh, vocabulary })).length).toBeGreaterThan(0);
    expect(errorsOf(compileAndTypecheck(source, { lexicon })).length).toBeGreaterThan(0);
  });

  it('compiles to the same Core IR as the ts and core proofs (positionFreeSha256)', () => {
    expect(positionFreeSha({})).toBe(JINGYESI_POSITION_FREE_SHA256);
    expect(() => positionFreeSha({ allowStructural: false })).toThrow(CompileFailure);
    expect(() => positionFreeSha({ aliases: null })).toThrow(CompileFailure);
    expect(() => positionFreeSha({ withVocabulary: false })).toThrow(CompileFailure);
  });

  it('evaluates the entry rule 地上霜 to the title 静夜思', () => {
    const compiled = compileAndTypecheck(source, { lexicon: withUserAliases(zh, aliasSet), vocabulary });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = evaluate(compiled.core as any, '地上霜', tpl.defaultInputs[ZH] as any);
    expect(result).toMatchObject({ success: true, value: '静夜思' });
    // 执行页按规则参数名预填：入口规则无参数，预填空输入
    expect(findExampleDefaultInput(source, [])).toEqual({});
  });

  it('layout round-trips to the source and passes validatePolicyLayout with zh-CN plus the frozen aliasSet', () => {
    expect(toCanonical(tpl.layout!)).toBe(source);
    expect(validatePolicyLayout(tpl.layout!, source, zh, aliasSet)).toEqual({ ok: true });
    expect(tpl.layout).toBe(POEMS.zh.layout);
  });

  it('display reads as the original poem, character for character', () => {
    const display = toDisplay(tpl.layout!);
    expect(display).toBe('床前明月光，\n疑是地上霜。\n举头望明月，\n低头思故乡。');
    expect(display.replace(/\n/g, '')).toBe(POEM_LINES);
  });

  it('has zh/en/de/hi copy describing aliases, the literal macro, the layout and the 静夜思 output', () => {
    expect(tpl.metadata['zh-CN'].name).toContain('静夜思');
    for (const locale of ['en-US', 'zh-CN', 'de-DE'] as const) {
      expect(tpl.metadata[locale].description, locale).toContain('静夜思');
      expect(tpl.metadata[locale].description, locale).toContain('思故乡');
      expect(tpl.metadata[locale].description, locale).toContain('望明月');
    }
    expect(tpl.metadata['hi-IN']?.description).toContain('静夜思');
    expect(tpl.metadata['en-US'].description).toMatch(/keyword aliases.*vocabulary.*literal.*display layout/);
    expect(tpl.metadata['zh-CN'].description).toMatch(/关键词别名.*本策略自带词汇.*字面量.*显示排版/);
    expect(tpl.metadata['de-DE'].description).toMatch(/Schlüsselwort-Aliase.*Vokabular.*Literal.*Anzeigelayout/);
    expect(tpl.metadata['hi-IN']?.description).toMatch(/कीवर्ड उपनाम.*शब्दावली.*लिटरल.*डिस्प्ले लेआउट/);
  });
});
