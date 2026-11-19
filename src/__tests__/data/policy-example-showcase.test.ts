/**
 * #791 结构化编写展示模板《静夜思》：按「真实策略」的口径校验（同 policy-layout-demos 的孤勇用例）。
 *
 * - 别名：zh-CN 词法表的占用集 + 不授予结构词，validateUserAliases 通过（客户端与服务端同一实现）。
 * - 编译：zh-CN + 模板 aliasSet 零诊断（与编辑器、保存门禁同一输入）；去掉 aliasSet 则解析失败——别名是承重的。
 * - 执行：自带 defaultInputs 真求值。
 * - 排版：toCanonical(layout) === source；validatePolicyLayout(zh-CN + 冻结 aliasSet) 通过，去掉 aliasSet 被
 *   layout_structural_hides_value 拒绝；toDisplay 的前四行就是原诗，且全部名字都原样可见。
 * - 不含领域词汇：内置 zh-CN 词汇只有显式 domain 才生效，编辑器与保存门禁都不传，模板因此不依赖它。
 */
import { describe, expect, it } from 'vitest';
import { compileAndTypecheck, evaluate } from '@aster-cloud/aster-lang-ts/browser';
import { toCanonical, toDisplay, validatePolicyLayout } from '@aster-cloud/aster-lang-ts/layout';
import { jingyesiShowcaseExample as tpl } from '@/data/policy-example-showcase';
import { getExampleSource, getExampleLocales, hasTemplateExtras, POLICY_EXAMPLES } from '@/data/policy-examples';
import { extractReservedAliasSets, getLexicon, withUserAliases } from '@/lib/aster-lexicon';
import { hasStructuralAliases, validateUserAliases } from '@/lib/policy-alias-shared';

const source = getExampleSource(tpl, 'en-US');
const aliasSet = Object.fromEntries(Object.entries(tpl.aliasSet ?? {}).map(([k, v]) => [k, [...v]]));
const zh = getLexicon('zh-CN');

function errorsOf(result: ReturnType<typeof compileAndTypecheck>): string[] {
  return [
    ...(result.parseErrors ?? []).map((e) => (typeof e === 'object' && e && 'message' in e ? String(e.message) : String(e))),
    ...(result.resolutionDiagnostics ?? []).map((d) => `${d.code}: ${d.message}`),
    ...(result.typeErrors ?? []).map((e) => e.message),
  ];
}

describe('showcase template: Jingyesi (#791)', () => {
  it('is in the catalog, pinned to zh-CN, with the same source for every UI locale', () => {
    expect(POLICY_EXAMPLES).toContain(tpl);
    expect(tpl.cnlLocale).toBe('zh-CN');
    expect(getExampleLocales(tpl)).toEqual(['zh-CN']);
    for (const locale of ['en-US', 'zh-CN', 'de-DE'] as const) expect(getExampleSource(tpl, locale)).toBe(source);
    expect(hasTemplateExtras(tpl)).toBe(true);
  });

  it('requires structured authoring only — no structural keyword alias grant', () => {
    expect(tpl.requires).toEqual({ structuredAuthoring: true });
    expect(hasStructuralAliases(aliasSet)).toBe(false);
  });

  it('aliasSet passes validateUserAliases for zh-CN without the structural grant', () => {
    const result = validateUserAliases(aliasSet, extractReservedAliasSets(zh), { allowStructural: false });
    expect(result).toEqual({ valid: true, errors: [], issues: [] });
  });

  it('source compiles with zh-CN plus the aliasSet, and only with it', () => {
    expect(errorsOf(compileAndTypecheck(source, { lexicon: withUserAliases(zh, aliasSet) }))).toEqual([]);
    expect(errorsOf(compileAndTypecheck(source, { lexicon: zh })).length).toBeGreaterThan(0);
  });

  it('declares a real Define struct that the rule takes as its parameter type', () => {
    expect(source).toMatch(/^定义 地上霜 包含\n {2}举头望明月，\n {2}低头思故乡。$/m);
    expect(source).toContain('规则 吟 给定 夜 作为 地上霜，产出 文本：');
  });

  it('evaluates with its defaultInputs', () => {
    const compiled = compileAndTypecheck(source, { lexicon: withUserAliases(zh, aliasSet) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = evaluate(compiled.core as any, '吟', tpl.defaultInputs['zh-CN'] as any);
    expect(result).toMatchObject({ success: true, value: '举头望明月，低头思故乡。' });
  });

  it('layout round-trips to the source exactly', () => {
    expect(toCanonical(tpl.layout!)).toBe(source);
  });

  it('layout passes validatePolicyLayout with zh-CN plus the frozen aliasSet', () => {
    expect(validatePolicyLayout(tpl.layout!, source, zh, aliasSet)).toEqual({ ok: true });
  });

  it('layout fails without the aliasSet', () => {
    // 没有别名时源码解析不了，验证器无法认定任何关键词，于是第一个结构 span 就被判为藏值。
    const result = validatePolicyLayout(tpl.layout!, source, zh);
    expect(result).toMatchObject({ ok: false, code: 'layout_structural_hides_value' });
  });

  it('display reads as the poem, then shows the rule with every name intact', () => {
    const display = toDisplay(tpl.layout!);
    expect(display.split('\n').slice(0, 4)).toEqual(['床前明月光，', '疑是地上霜。', '举头望明月，', '低头思故乡。']);
    expect(display).toContain('规则 吟 给定 夜 作为 地上霜，产出 文本：');
    expect(display).toContain('返回 夜.举头望明月 接着 夜.低头思故乡。');
  });

  it('carries no domain vocabulary (built-in zh-CN vocabularies are not applied on the save path)', () => {
    expect(Object.keys(tpl)).not.toContain('vocabulary');
    expect(tpl.metadata['zh-CN'].description).toContain('词汇');
    expect(tpl.metadata['en-US'].description).toContain('Vocabulary tab');
  });

  it('has zh/en/de/hi metadata; en/de/hi say it is a Chinese showcase', () => {
    expect(tpl.metadata['zh-CN'].name).toContain('静夜思');
    expect(tpl.metadata['en-US'].description).toContain('Chinese');
    expect(tpl.metadata['de-DE'].description).toContain('chinesische');
    expect(tpl.metadata['hi-IN']?.description).toContain('चीनी');
  });
});
