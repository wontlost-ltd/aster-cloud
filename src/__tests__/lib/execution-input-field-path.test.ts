/**
 * 输入缺字段的路径还原为策略语言（生产复测第 6 轮第 4 项）：引擎报的是规范名路径（person.age），
 * 用户在执行页按策略语言写输入（person.alter），提示里应显示用户写的那个名字。
 */
import { describe, expect, it, vi } from 'vitest';
import { assembleDomainVocabularyFromLinks, type TermLikeRow } from '@/lib/domain-vocabulary-assemble';

// index.ts 顶层引入词汇加载（DB）；本测试只用纯函数部分。
vi.mock('@/lib/domain-vocabulary-snapshot', () => ({
  loadExecutionVocabulary: vi.fn(),
  loadLiveVocabularyForPolicy: vi.fn(),
}));

const { prepareExecutionInput } = await import('@/lib/execution-input');

function row(kind: string, canonical: string, localized: string, parent: string | null = null): TermLikeRow {
  return { domainTermId: `${kind}-${canonical}`, domain: 'e2e1028', locale: 'de', kind, canonical, localized, parentCanonical: parent, aliases: [] };
}

const VOCAB = assembleDomainVocabularyFromLinks([
  row('struct', 'Driver', 'Fahrer'),
  row('struct', 'Level', 'Stufe'),
  row('field', 'age', 'alter', 'Driver'),
  row('field', 'rank', 'niveau', 'Driver'),
  row('enum_value', 'High', 'Hoch', 'Level'),
  row('enum_value', 'Low', 'Niedrig', 'Level'),
], { domain: 'e2e1028', locale: 'de-DE' }) as unknown as Record<string, unknown>;

const SOURCE = `Modul e2e1028.vocab.

Definiere Stufe als eines von Hoch, Niedrig.

Definiere Fahrer hat alter als Ganzzahl, niveau als Stufe.

Regel einstufen gegeben person als Fahrer liefert Stufe:
  gib zurück person.niveau.
`;

function localizerFor(vocabulary: Record<string, unknown> | undefined) {
  const prepared = prepareExecutionInput({
    input: {}, functionName: 'einstufen', vocabulary, source: SOURCE, locale: 'de-DE', aliasSet: null,
  });
  if (!prepared.ok) throw new Error('unexpected failure');
  return prepared.localizeFieldPath;
}

describe('prepareExecutionInput().localizeFieldPath', () => {
  it('参数名开头的路径：字段规范名还原为策略语言写法', () => {
    expect(localizerFor(VOCAB)('person.age')).toBe('person.alter');
    expect(localizerFor(VOCAB)('person.rank')).toBe('person.niveau');
  });

  it('单参数平铺输入（不带参数名）：同样按该参数的类型还原', () => {
    expect(localizerFor(VOCAB)('age')).toBe('alter');
  });

  it('只有参数名、未知字段或无法确定类型的段原样保留', () => {
    expect(localizerFor(VOCAB)('person')).toBe('person');
    expect(localizerFor(VOCAB)('person.unknown')).toBe('person.unknown');
    expect(localizerFor(VOCAB)('person.age.deeper')).toBe('person.alter.deeper');
  });

  it('无词汇时原样返回', () => {
    expect(localizerFor(undefined)('person.age')).toBe('person.age');
  });
});
