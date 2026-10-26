/**
 * #626 执行输入映射：策略语言字段名 / 枚举值 / 类型标签 → 规范名。
 *
 * 词汇与生产复现一致（e2e1027/de：Driver→Fahrer、age→alter），并补充同义词、列表、枚举。
 * 类型信息由真实编译器从德语源码提取（与执行路由同一路径）。
 */
import { describe, expect, it } from 'vitest';
import { assembleDomainVocabularyFromLinks, type TermLikeRow } from '@/lib/domain-vocabulary-assemble';
import {
  buildVocabularyNameIndex,
  localizeExecutionOutput,
  mapExecutionInput,
  mapFunctionName,
  type PolicyInputTypes,
} from '@/lib/execution-input/mapper';
import { extractPolicyInputTypes } from '@/lib/execution-input/policy-types';

function row(kind: string, canonical: string, localized: string, parent: string | null = null, aliases: string[] = []): TermLikeRow {
  return { domainTermId: `${kind}-${canonical}`, domain: 'e2e1027', locale: 'de', kind, canonical, localized, parentCanonical: parent, aliases };
}

const VOCAB = assembleDomainVocabularyFromLinks(
  [
    row('struct', 'Driver', 'Fahrer'),
    row('struct', 'Child', 'Kind'),
    row('field', 'age', 'alter', 'Driver', ['lebensalter']),
    row('field', 'children', 'kinder', 'Driver'),
    row('field', 'tier', 'stufe', 'Driver'),
    row('struct', 'Tier', 'Stufe'),
    row('enum_value', 'GOLD', 'Gold', 'Tier'),
    row('enum_value', 'SILVER', 'Silber', 'Tier'),
    row('function', 'evaluate', 'bewerten'),
  ],
  { domain: 'e2e1027', locale: 'de-DE' },
);
const INDEX = buildVocabularyNameIndex(VOCAB)!;

const DE_POLICY = `Modul e2e1027.vocab.

Definiere Stufe als eines von Gold, Silber.

Definiere Kind hat alter als Ganzzahl.

Definiere Fahrer hat alter als Ganzzahl, stufe als Stufe, kinder als List of Kind, notiz als Text.

Regel bewerten gegeben person als Fahrer liefert Ganzzahl:
  wenn person.alter mindestens 18:
    gib zurück 42.
  gib zurück 0.
`;
const TYPES = extractPolicyInputTypes(DE_POLICY, 'de-DE', null, undefined)!;

function mapped(input: unknown, types: PolicyInputTypes | null = TYPES) {
  const result = mapExecutionInput(input, INDEX, types);
  if (!result.ok) throw new Error(`unexpected ambiguity: ${JSON.stringify(result.ambiguous)}`);
  return result.input;
}

describe('extractPolicyInputTypes', () => {
  it('从德语源码提取参数、结构、枚举（名字保持策略语言）', () => {
    expect(TYPES.params.map((p) => p.name)).toEqual(['person']);
    const enumDecl = TYPES.decls.find((d) => d.kind === 'Enum');
    expect(enumDecl).toMatchObject({ name: 'Stufe', variants: ['Gold', 'Silber'] });
    const driver = TYPES.decls.find((d) => d.name === 'Fahrer');
    expect(driver && 'fields' in driver ? driver.fields.map((f) => f.name) : []).toEqual(['alter', 'stufe', 'kinder', 'notiz']);
  });

  it('源码无法解析时返回 null（映射退化为只映射键）', () => {
    expect(extractPolicyInputTypes('Modul x.\n\nRegel kaputt gegeben', 'de-DE', null, undefined)).toBeNull();
  });
});

describe('mapExecutionInput — 生产复现', () => {
  it('本地化输入 {"person":{"alter":21}} → {"person":{"age":21}}', () => {
    expect(mapped({ person: { alter: 21 } })).toEqual({ person: { age: 21 } });
  });

  it('规范输入仍然接受、结果相同', () => {
    expect(mapped({ person: { age: 21 } })).toEqual({ person: { age: 21 } });
  });

  it('同一对象内本地化键与规范键并存 → 歧义，带字段路径与策略语言名', () => {
    const result = mapExecutionInput({ person: { alter: 21, age: 30 } }, INDEX, TYPES);
    expect(result).toEqual({
      ok: false,
      ambiguous: { field: 'person.age', fields: ['person.alter', 'person.age'], canonical: 'age', policyName: 'alter' },
    });
  });

  it('两个同义词（本地化名 + 词汇别名）并存同样歧义', () => {
    const result = mapExecutionInput({ person: { alter: 21, lebensalter: 30 } }, INDEX, TYPES);
    expect(result.ok).toBe(false);
  });

  it('词汇别名单独使用时映射为规范名；匹配大小写不敏感（与执行端规范化一致）', () => {
    expect(mapped({ person: { Lebensalter: 21 } })).toEqual({ person: { age: 21 } });
    expect(mapped({ person: { ALTER: 21 } })).toEqual({ person: { age: 21 } });
  });

  it('未知键原样保留', () => {
    expect(mapped({ person: { alter: 21, extra: 'x' }, sonst: 1 })).toEqual({ person: { age: 21, extra: 'x' }, sonst: 1 });
  });
});

describe('mapExecutionInput — 结构与类型', () => {
  it('参数名来自源码，原样使用（即使与词条同名）', () => {
    expect(mapped({ fahrer: { alter: 1 } }, null)).toEqual({ fahrer: { age: 1 } });
  });

  it('结构列表逐项映射，歧义路径带下标', () => {
    expect(mapped({ person: { kinder: [{ alter: 3 }, { age: 5 }] } })).toEqual({ person: { children: [{ age: 3 }, { age: 5 }] } });
    const result = mapExecutionInput({ person: { kinder: [{ alter: 3 }, { alter: 4, age: 5 }] } }, INDEX, TYPES);
    expect(result.ok ? null : result.ambiguous.field).toBe('person.kinder[1].age');
  });

  it('枚举字段的策略语言值 → 规范值；规范值仍然接受', () => {
    expect(mapped({ person: { stufe: 'Gold' } })).toEqual({ person: { tier: 'GOLD' } });
    expect(mapped({ person: { stufe: 'SILVER' } })).toEqual({ person: { tier: 'SILVER' } });
  });

  it('不是该枚举成员的值、以及非枚举字段的文本不改写', () => {
    expect(mapped({ person: { stufe: 'Platin', notiz: 'Gold' } })).toEqual({ person: { tier: 'Platin', notiz: 'Gold' } });
  });

  it('无类型信息时不动枚举值，只映射字段键', () => {
    expect(mapped({ person: { stufe: 'Gold', alter: 2 } }, null)).toEqual({ person: { tier: 'Gold', age: 2 } });
  });

  it('类型标签 __type 的结构名映射为规范名，并按标签结构映射字段', () => {
    expect(mapped({ person: { __type: 'Fahrer', stufe: 'Silber' } }, { params: [], decls: TYPES.decls }))
      .toEqual({ person: { __type: 'Driver', tier: 'SILVER' } });
  });

  it('Map 类型的键是数据，不映射；值按值类型映射', () => {
    const types: PolicyInputTypes = {
      params: [{ name: 'stufen', type: { kind: 'Map', key: { kind: 'TypeName', name: 'Text' }, val: { kind: 'TypeName', name: 'Stufe' } } }],
      decls: TYPES.decls,
    };
    expect(mapped({ stufen: { alter: 'Gold' } }, types)).toEqual({ stufen: { alter: 'GOLD' } });
  });

  it('数组形式的位置参数按参数位置取类型', () => {
    expect(mapped([{ alter: 9, stufe: 'Gold' }])).toEqual([{ age: 9, tier: 'GOLD' }]);
  });

  it('__proto__ 键作为普通自有属性保留，不污染原型', () => {
    const input = JSON.parse('{"person":{"__proto__":{"polluted":true},"alter":1}}');
    const out = mapped(input) as { person: Record<string, unknown> };
    expect(Object.prototype.hasOwnProperty.call(out.person, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('无词汇 / 英文策略不受影响', () => {
  it('无词汇时输入原样返回（同一引用）', () => {
    const input = { person: { alter: 21, age: 30 } };
    const result = mapExecutionInput(input, null, TYPES);
    expect(result).toEqual({ ok: true, input });
    expect(result.ok && result.input).toBe(input);
  });

  it('空词汇或形状不对时不建索引', () => {
    expect(buildVocabularyNameIndex(undefined)).toBeNull();
    expect(buildVocabularyNameIndex({ structs: [], fields: [] })).toBeNull();
    expect(buildVocabularyNameIndex('x')).toBeNull();
  });

  it('字面量宏不参与输入映射', () => {
    const index = buildVocabularyNameIndex({ structs: [], fields: [], functions: [], literals: [{ canonical: 'Text', localized: 'gruss', kind: 'literal' }] });
    expect(index).toBeNull();
  });
});

describe('输出本地化与函数名', () => {
  it('结果里的规范字段名与枚举值还原为策略语言', () => {
    const types: PolicyInputTypes = { ...TYPES, result: { kind: 'TypeName', name: 'Fahrer' } };
    expect(localizeExecutionOutput({ age: 3, tier: 'GOLD', other: 1 }, INDEX, types)).toEqual({ alter: 3, stufe: 'Gold', other: 1 });
  });

  it('无类型时按词汇反查键，标量原样', () => {
    expect(localizeExecutionOutput({ age: 3 }, INDEX, null)).toEqual({ alter: 3 });
    expect(localizeExecutionOutput(42, INDEX, TYPES)).toBe(42);
    expect(localizeExecutionOutput({ age: 3 }, null, null)).toEqual({ age: 3 });
  });

  it('函数名按词汇规范化，规范名与未知名原样', () => {
    expect(mapFunctionName('bewerten', INDEX)).toBe('evaluate');
    expect(mapFunctionName('evaluate', INDEX)).toBe('evaluate');
    expect(mapFunctionName(undefined, INDEX)).toBeUndefined();
    expect(mapFunctionName('bewerten', null)).toBe('bewerten');
  });
});
