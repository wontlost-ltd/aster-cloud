import { describe, it, expect } from 'vitest';
import { collectKeywordLabels, buildKeywordSuggestions } from '@/lib/aster-keyword-completions';
import { EN_US, ZH_CN, DE_DE, HI_IN, type Lexicon } from '@/lib/aster-lexicon';

/**
 * playground 编辑器的关键词补全必须随 locale 切换。
 *
 * ★背景：此前编辑器**只有 `Use` 行有补全**，其余位置一律
 * `return { suggestions: [] }` —— 而写 CNL 时绝大多数时间都不在 Use 行上。
 * 补上之后必须保证取词来源正确：给写 zh 的用户 `module/rule/return`
 * 等于每一条都是错的（选中即解析失败）。
 *
 * 这与 aster-lang-ts#160 修的 LSP 侧是同一类缺陷（那边是硬编码 `Object.values(KW)`）。
 */
describe('CNL 关键词补全取词', () => {
  it('★zh-CN 给中文关键词，且不含英文', () => {
    const labels = collectKeywordLabels(ZH_CN);

    for (const kw of ['模块', '规则', '返回']) {
      expect(labels, `应包含「${kw}」，实际前 8 个：${labels.slice(0, 8).join(', ')}`).toContain(kw);
    }
    // ★反向断言用「不含任何纯 ASCII 关键词」而非逐个列举：
    //   实测 zh-CN 的 79 个关键词里 ASCII 词为 0，故这条比列举更强——
    //   列举只能挡住我想到的那几个，而这条挡住全部。
    expect(labels.filter((w) => /^[A-Za-z][A-Za-z ]*$/.test(w)),
      'zh-CN 补全不得混入英文关键词').toEqual([]);
  });

  it('★de-DE / hi-IN 各自给本语言关键词', () => {
    const de = collectKeywordLabels(DE_DE);
    expect(de).toContain('Modul');
    // de-DE 的规范拼写是 `Modul`，不得同时出现 en 的 `Module`
    expect(de).not.toContain('Module');

    const hi = collectKeywordLabels(HI_IN);
    expect(hi.some((w) => /[ऀ-ॿ]/.test(w)), 'hi-IN 应含天城文关键词').toBe(true);
    expect(hi).not.toContain('Module');
  });

  it('en-US 给英文关键词（回归对照）', () => {
    const labels = collectKeywordLabels(EN_US);
    // ★实测 en-US 的规范拼写是 `Module`（首字母大写），不是 `module` ——
    //   第一版按小写断言而失败。断言字面量必须来自实际数据，不能凭印象写。
    expect(labels).toContain('Module');
    expect(labels.length).toBeGreaterThan(50);
  });

  it('★别名一并纳入，且不挤掉规范拼写（ADR 0022）', () => {
    // 四个内置 lexicon 的 aliases 目前均为空，故用合成 lexicon 验证**接线**本身。
    // 不这么做的话，将来某个 lexicon 一加别名，补全会静默落后而无人发现。
    const withAlias = {
      ...ZH_CN,
      aliases: { MODULE_IS: ['模組'] },
    } as unknown as Lexicon;

    const labels = collectKeywordLabels(withAlias);
    expect(labels, '别名应出现在补全里').toContain('模組');
    expect(labels, '加别名不得挤掉规范拼写').toContain('模块');
  });

  it('补全项去重（关键词与别名可能重叠）', () => {
    const labels = collectKeywordLabels(ZH_CN);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('无 lexicon 时返回空数组（不得抛错拖垮补全子系统）', () => {
    expect(collectKeywordLabels(undefined)).toEqual([]);
  });
});

/**
 * ★这一组守的是 **provider 真的返回了补全项**，而非只守取词逻辑。
 *
 * 背景（同一天犯的第二次同类错）：上一版只测 collectKeywordLabels。
 * 实测变异——把组件里 `collectKeywordLabels(lexiconRef.current)` 换成 `[]`——
 * **12 条用例全部照绿**。纯函数测得再好，也证明不了调用方用了它。
 *
 * 这与 aster-lang-ts#162（第16种假绿）是同一个坑：
 * 「抽了纯函数、测了纯函数，却没测调用点」。
 *
 * 把 provider 分支的**全部逻辑**收进 buildKeywordSuggestions 之后，
 * 组件里只剩一次转发，调用点才真正被锁住。
 */
describe('补全 provider 返回结果', () => {
  const KEYWORD_KIND = 17; // monaco CompletionItemKind.Keyword
  const RANGE = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 5 };

  it('★返回非空 suggestions（恒空即为缺陷）', () => {
    const { suggestions } = buildKeywordSuggestions(ZH_CN, KEYWORD_KIND, RANGE);
    expect(suggestions.length).toBeGreaterThan(50);
  });

  it('★每一项的 label / insertText 都是本 locale 的关键词', () => {
    const { suggestions } = buildKeywordSuggestions(ZH_CN, KEYWORD_KIND, RANGE);
    const labels = suggestions.map((s) => s.label);
    expect(labels).toContain('模块');
    // insertText 必须与 label 一致——补全选中后插入的就是这个词
    for (const s of suggestions) expect(s.insertText).toBe(s.label);
    // 不得混入英文（给写 zh 的用户英文词，选中即解析失败）
    expect(labels.filter((w) => /^[A-Za-z][A-Za-z ]*$/.test(w))).toEqual([]);
  });

  it('★kind 与 range 原样透传（错了补全会插错位置/图标）', () => {
    const { suggestions } = buildKeywordSuggestions(EN_US, KEYWORD_KIND, RANGE);
    expect(suggestions.every((s) => s.kind === KEYWORD_KIND)).toBe(true);
    expect(suggestions.every((s) => s.range === RANGE)).toBe(true);
  });

  it('别名进入 suggestions（不只进 labels）', () => {
    const withAlias = { ...ZH_CN, aliases: { MODULE_IS: ['模組'] } } as unknown as Lexicon;
    const { suggestions } = buildKeywordSuggestions(withAlias, KEYWORD_KIND, RANGE);
    expect(suggestions.map((s) => s.label)).toContain('模組');
  });

  it('无 lexicon 时返回空 suggestions（不抛错）', () => {
    expect(buildKeywordSuggestions(undefined, KEYWORD_KIND, RANGE)).toEqual({ suggestions: [] });
  });
});

/**
 * ★aliasSet 有一条**无形态校验**的入口：
 *   policies/[id]/edit/page.tsx 直接 `JSON.parse(...) as Record<string, string[]>`，
 *   而 execute-policy-content.tsx 那条路径做了完整的 Array.isArray 校验。
 *   两条路径口径不一致，edit 路径是敞开的 —— 脏数据能一路走到这里。
 */
describe('非法 aliases 的健壮性', () => {
  it('★alias 值为 undefined 时不得混入补全（否则 Monaco 收到 label:undefined）', () => {
    const dirty = { ...ZH_CN, aliases: { MODULE_IS: undefined } } as unknown as Lexicon;
    const labels = collectKeywordLabels(dirty);
    expect(labels.every((l) => typeof l === 'string')).toBe(true);
    expect(labels).not.toContain(undefined as unknown as string);
  });

  it('alias 数组里混入非字符串时被剔除', () => {
    const dirty = {
      ...ZH_CN,
      aliases: { MODULE_IS: ['模組', null, 42, undefined] },
    } as unknown as Lexicon;
    const labels = collectKeywordLabels(dirty);
    expect(labels).toContain('模組');
    expect(labels.every((l) => typeof l === 'string')).toBe(true);
  });
});
