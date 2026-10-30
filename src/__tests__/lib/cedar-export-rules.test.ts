// 导出为 Cedar 时选择规则（#661）：从 E720 取多候选；规则名归属校验（源码写法 + 词汇规范名）。
import { describe, it, expect } from 'vitest';
import { cedarRuleCandidates, policyRuleNames } from '@/lib/cedar-export-rules';

const e720 = (message: string) => ({ code: 'E720', message });

describe('cedarRuleCandidates', () => {
  it('E720 多候选：按声明顺序取出候选名', () => {
    expect(cedarRuleCandidates([e720('Module "m" cannot be exported to Cedar: several rules can be exported (allowRead, allowWrite); choose one')]))
      .toEqual(['allowRead', 'allowWrite']);
  });

  it('非 ASCII 规则名原样保留', () => {
    expect(cedarRuleCandidates([e720('several rules can be exported (允许读取, 允许写入); choose one')])).toEqual(['允许读取', '允许写入']);
  });

  it('E720 没有 guard 形态的规则、其他诊断码、无诊断：没有候选', () => {
    expect(cedarRuleCandidates([e720('no rule has the guard request shape')])).toEqual([]);
    expect(cedarRuleCandidates([{ code: 'E721', message: 'several rules can be exported (a, b); choose one' }])).toEqual([]);
    expect(cedarRuleCandidates([])).toEqual([]);
  });
});

describe('policyRuleNames', () => {
  const de = 'Modul m.\n\nRegel leseErlaubt gegeben anfrage:\n  Gib zurueck wahr.\n\nRegel schreibeErlaubt gegeben anfrage:\n  Gib zurueck falsch.\n';

  it('源码里声明的规则名（en / zh / de 关键词）', () => {
    expect([...policyRuleNames('Module m.\n\nRule a given x:\n  Return x.\n')]).toEqual(['a']);
    expect([...policyRuleNames('模块 m。\n\n规则 允许 给定 x：\n  返回 x。\n')]).toEqual(['允许']);
    expect([...policyRuleNames(de)]).toEqual(['leseErlaubt', 'schreibeErlaubt']);
  });

  it('经版本词汇本地化的规则同时接受规范名（含别名命中）', () => {
    const vocabulary = {
      functions: [
        { canonical: 'allowRead', localized: 'leseErlaubt' },
        { canonical: 'allowWrite', localized: 'schreibRecht', aliases: ['schreibeErlaubt'] },
        { canonical: 'unused', localized: 'nichtImQuelltext' },
      ],
    };
    expect([...policyRuleNames(de, vocabulary)].sort()).toEqual(['allowRead', 'allowWrite', 'leseErlaubt', 'schreibeErlaubt']);
  });

  it('词汇形状异常时只按源码判断', () => {
    expect([...policyRuleNames(de, { functions: 'x' })]).toEqual(['leseErlaubt', 'schreibeErlaubt']);
    expect([...policyRuleNames(de, { functions: [{ canonical: 1, localized: 'leseErlaubt' }] })]).toEqual(['leseErlaubt', 'schreibeErlaubt']);
  });
});
