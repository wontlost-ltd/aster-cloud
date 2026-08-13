import { describe, it, expect } from 'vitest';
import { detectCNLLocale } from '@/services/policy/cnl-executor';
import { POLICY_EXAMPLES, type SupportedLocale } from '@/data/policy-examples';

/**
 * CNL 语种检测必须按**词**匹配，不能用子串包含。
 *
 * <h2>被修复的真实事故</h2>
 *
 * <p>德语关键词表里有 <code>'Modul'</code>，而检测用的是
 * <code>content.toLowerCase().includes(keyword.toLowerCase())</code>。
 * 英文 CNL 的第一行是 <code>Module finance.loan.</code>——
 * <code>Module</code> 里包含 <code>Modul</code>，于是<b>每一份英文策略
 * 都被判成德语</b>，改用德语词典解析。
 *
 * <p>德语词典里没有 <code>less than</code>，于是报
 * 「无法识别此处的运算符或关键词」。实测英文 loan 模板走 de-DE 时
 * 在「行 15 第 23 列」失败，与用户报的位置逐字一致；走 en-US 则解析通过。
 *
 * <p>★这个 bug 的隐蔽之处：报错指向比较运算符，而真因在**语种检测**，
 * 相隔两层。用户按提示反复修改比较写法，怎么改都没用。
 */
describe('detectCNLLocale — 按词匹配而非子串', () => {
  it('★英文 `Module ...` 不得因含 "Modul" 被判成德语', () => {
    const src = 'Module finance.loan.\n\nRule r given x, produce:\n  If x is less than 18\n    Return 1.\n';
    expect(detectCNLLocale(src)).toBe('en-US');
  });

  it('真正的德语源码仍须判为 de-DE', () => {
    const src = 'Modul Finanz.Kredit.\n\nDefiniere Antragsteller hat\n  alter.\n';
    expect(detectCNLLocale(src)).toBe('de-DE');
  });

  it('中文源码仍须判为 zh-CN', () => {
    expect(detectCNLLocale('模块 金融.贷款。\n\n定义 申请人 包含\n  年龄。\n')).toBe('zh-CN');
  });

  /** 全部内置样例的语种必须被正确识别——修复前 5 个英文样例全部误判。 */
  it('★15 个内置样例（5 示例 × 3 语种）语种检测全部正确', () => {
    const wrong: string[] = [];
    for (const ex of POLICY_EXAMPLES) {
      for (const loc of Object.keys(ex.sources) as SupportedLocale[]) {
        const got = detectCNLLocale(ex.sources[loc]);
        if (got !== loc) wrong.push(`${ex.id}[${loc}] -> ${got}`);
      }
    }
    expect(wrong, `误判: ${wrong.join(', ')}`).toEqual([]);
  });

  /** 其它德语词也不得被英文单词的子串命中（如 Falls ⊂ "Fallsafe"）。 */
  it('德语词作为其它单词的一部分不得命中', () => {
    expect(detectCNLLocale('Module m.\nRule r given fallsafe, produce:\n  Return 1.\n')).toBe('en-US');
  });
});
