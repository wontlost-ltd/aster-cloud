// 导出为 Cedar 时选择规则（#661）：从 E720 取多候选；规则名归属校验（源码写法 + 词汇规范名）。
import { describe, it, expect } from 'vitest';
import { cedarRuleCandidates, resolvePolicyRuleName } from '@/lib/cedar-export-rules';

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

describe('resolvePolicyRuleName', () => {
  const de = 'Modul m.\n\nRegel leseErlaubt gegeben anfrage:\n  Gib zurueck wahr.\n\nRegel schreibeErlaubt gegeben anfrage:\n  Gib zurueck falsch.\n';
  const vocabulary = {
    functions: [
      { canonical: 'allowRead', localized: 'leseErlaubt' },
      { canonical: 'allowWrite', localized: 'schreibRecht', aliases: ['schreibeErlaubt'] },
      { canonical: 'unused', localized: 'nichtImQuelltext' },
    ],
  };

  it('源码里声明的规则（en / zh / de 关键词）原样返回', () => {
    expect(resolvePolicyRuleName('Module m.\n\nRule a given x:\n  Return x.\n', undefined, 'a')).toBe('a');
    expect(resolvePolicyRuleName('模块 m。\n\n规则 允许 给定 x：\n  返回 x。\n', undefined, '允许')).toBe('允许');
    expect(resolvePolicyRuleName(de, undefined, 'schreibeErlaubt')).toBe('schreibeErlaubt');
  });

  it('经版本词汇本地化的规则：规范名原样返回，源码写法（含别名命中）换成规范名', () => {
    expect(resolvePolicyRuleName(de, vocabulary, 'allowRead')).toBe('allowRead');
    expect(resolvePolicyRuleName(de, vocabulary, 'leseErlaubt')).toBe('allowRead');
    expect(resolvePolicyRuleName(de, vocabulary, 'schreibeErlaubt')).toBe('allowWrite');
  });

  it('不是该版本的规则：null（词汇里有但源码没有的也不算）', () => {
    expect(resolvePolicyRuleName(de, vocabulary, 'unused')).toBeNull();
    expect(resolvePolicyRuleName(de, vocabulary, 'deleteEverything')).toBeNull();
    expect(resolvePolicyRuleName('Module m.\n\n// Rule hidden given x:\n', undefined, 'hidden')).toBeNull();
  });

  it('词汇形状异常时只按源码判断', () => {
    expect(resolvePolicyRuleName(de, { functions: 'x' }, 'leseErlaubt')).toBe('leseErlaubt');
    expect(resolvePolicyRuleName(de, { functions: [{ canonical: 1, localized: 'leseErlaubt' }] }, 'leseErlaubt')).toBe('leseErlaubt');
  });
});
