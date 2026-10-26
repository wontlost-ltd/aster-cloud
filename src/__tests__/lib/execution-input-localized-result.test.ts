/**
 * dashboard 执行响应的 localizedResult（#633）：从真实德语策略源码取返回类型，
 * 引擎返回的枚举值对象 / 含枚举的结构 / 列表都按策略语言还原；与原值相同时不附带。
 */
import { describe, expect, it, vi } from 'vitest';
import { assembleDomainVocabularyFromLinks, type TermLikeRow } from '@/lib/domain-vocabulary-assemble';

// index.ts 顶层引入词汇加载（DB）；本测试只用纯函数部分。
vi.mock('@/lib/domain-vocabulary-snapshot', () => ({
  loadExecutionVocabulary: vi.fn(),
  loadLiveVocabularyForPolicy: vi.fn(),
}));

const { localizedResultField, prepareExecutionInput } = await import('@/lib/execution-input');

function row(kind: string, canonical: string, localized: string, parent: string | null = null): TermLikeRow {
  return { domainTermId: `${kind}-${canonical}`, domain: 'e2e1028', locale: 'de', kind, canonical, localized, parentCanonical: parent, aliases: [] };
}

// 与生产复测同一套词汇：struct Driver↔Fahrer、Level↔Stufe，字段 level↔niveau，枚举值 High↔Hoch / Low↔Niedrig。
const VOCAB = assembleDomainVocabularyFromLinks([
  row('struct', 'Driver', 'Fahrer'),
  row('struct', 'Level', 'Stufe'),
  row('field', 'age', 'alter', 'Driver'),
  row('field', 'level', 'niveau', 'Driver'),
  row('enum_value', 'High', 'Hoch', 'Level'),
  row('enum_value', 'Low', 'Niedrig', 'Level'),
], { domain: 'e2e1028', locale: 'de-DE' }) as unknown as Record<string, unknown>;

const SOURCE = `Modul e2e1028.vocab.

Definiere Stufe als eines von Hoch, Niedrig.

Definiere Fahrer hat alter als Ganzzahl, niveau als Stufe.

Regel einstufen gegeben person als Fahrer liefert Stufe:
  gib zurück person.niveau.

Regel echo gegeben person als Fahrer liefert Fahrer:
  gib zurück person.

Regel alle gegeben person als Fahrer liefert List of Stufe:
  gib zurück [person.niveau].
`;

const enumValue = (enumName: string, member: string) =>
  ({ __type: '?', _enum: enumName, value: member, variant: member, args: [] });

function localizerFor(functionName: string) {
  const prepared = prepareExecutionInput({
    input: {}, functionName, vocabulary: VOCAB, source: SOURCE, locale: 'de-DE', aliasSet: null,
  });
  if (!prepared.ok) throw new Error('unexpected ambiguity');
  return (result: unknown) => localizedResultField(result, prepared.localizeOutput);
}

describe('localizedResultField（#633）', () => {
  it('返回枚举值对象：附带策略语言的枚举名与成员名', () => {
    expect(localizerFor('einstufen')(enumValue('Level', 'High')))
      .toEqual({ localizedResult: enumValue('Stufe', 'Hoch') });
  });

  it('返回含枚举的结构：字段名与枚举值一并还原', () => {
    expect(localizerFor('echo')({ age: 21, level: enumValue('Level', 'Low') }))
      .toEqual({ localizedResult: { alter: 21, niveau: enumValue('Stufe', 'Niedrig') } });
    expect(localizerFor('echo')({ age: 21, level: 'Low' }))
      .toEqual({ localizedResult: { alter: 21, niveau: 'Niedrig' } });
  });

  it('返回枚举列表：逐个还原', () => {
    expect(localizerFor('alle')([enumValue('Level', 'High'), 'Low']))
      .toEqual({ localizedResult: [enumValue('Stufe', 'Hoch'), 'Niedrig'] });
  });

  it('本地化后与原值相同、或结果为空时不附带', () => {
    expect(localizerFor('einstufen')('Medium')).toEqual({});
    expect(localizerFor('einstufen')(42)).toEqual({});
    expect(localizerFor('einstufen')(null)).toEqual({});
    expect(localizerFor('einstufen')(undefined)).toEqual({});
  });
});
