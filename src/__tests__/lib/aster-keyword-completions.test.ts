import { describe, it, expect } from 'vitest';
import { collectKeywordLabels } from '@/lib/aster-keyword-completions';
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
