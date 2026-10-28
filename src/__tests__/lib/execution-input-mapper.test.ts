/**
 * #626 执行输入映射：只在类型确定的位置把策略语言字段名 / 枚举值 / 类型标签映射为规范名。
 *
 * 词汇与生产复现一致（e2e1027/de：Driver→Fahrer、age→alter），并补充同义词、列表、枚举。
 * 类型信息一部分由真实编译器从德语源码提取（与执行路由同一路径），撞名等边界用手写类型精确构造。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assembleDomainVocabularyFromLinks, type TermLikeRow } from '@/lib/domain-vocabulary-assemble';
import {
  buildMappingModel,
  buildVocabularyNameIndex,
  localizeExecutionOutput,
  mapExecutionInput,
  mapFunctionName,
  type PolicyInputTypes,
  type PolicyTypeNode,
} from '@/lib/execution-input/mapper';
import { extractPolicyInputTypes } from '@/lib/execution-input/policy-types';

/** 只取成功时的类型（失败返回 null），便于沿用按类型断言的用例。 */
function extractTypes(...args: Parameters<typeof extractPolicyInputTypes>) {
  const result = extractPolicyInputTypes(...args);
  return result.ok ? result.types : null;
}

function row(kind: string, canonical: string, localized: string, parent: string | null = null, aliases: string[] = []): TermLikeRow {
  return { domainTermId: `${kind}-${canonical}-${localized}`, domain: 'e2e1027', locale: 'de', kind, canonical, localized, parentCanonical: parent, aliases };
}

function vocab(rows: TermLikeRow[]) {
  return assembleDomainVocabularyFromLinks(rows, { domain: 'e2e1027', locale: 'de-DE' });
}

const BASE_ROWS = [
  row('struct', 'Driver', 'Fahrer'),
  row('struct', 'Child', 'Kind'),
  row('field', 'age', 'alter', 'Driver', ['lebensalter']),
  row('field', 'children', 'kinder', 'Driver'),
  row('field', 'tier', 'stufe', 'Driver'),
  row('struct', 'Tier', 'Stufe'),
  row('enum_value', 'GOLD', 'Gold', 'Tier'),
  row('enum_value', 'SILVER', 'Silber', 'Tier'),
  row('function', 'evaluate', 'bewerten'),
];
const INDEX = buildVocabularyNameIndex(vocab(BASE_ROWS))!;

const DE_POLICY = `Modul e2e1027.vocab.

Definiere Stufe als eines von Gold, Silber.

Definiere Kind hat alter als Ganzzahl.

Definiere Fahrer hat alter als Ganzzahl, stufe als Stufe, kinder als List of Kind, notiz als Text.

Regel bewerten gegeben person als Fahrer liefert Ganzzahl:
  wenn person.alter mindestens 18:
    gib zurück 42.
  gib zurück 0.
`;
const TYPES = extractTypes({ source: DE_POLICY, locale: 'de-DE', aliasSet: null }, undefined)!;
const MODEL = buildMappingModel(INDEX, TYPES);

const T = (name: string): PolicyTypeNode => ({ kind: 'TypeName', name });

function mapped(input: unknown, model = MODEL) {
  const result = mapExecutionInput(input, model);
  if (!result.ok) throw new Error(`unexpected ambiguity: ${JSON.stringify(result.ambiguous)}`);
  return result.input;
}

afterEach(() => vi.restoreAllMocks());

describe('extractPolicyInputTypes', () => {
  it('从德语源码提取参数、结构、枚举（名字保持策略语言）', () => {
    expect(TYPES.params.map((p) => p.name)).toEqual(['person']);
    expect(TYPES.decls.find((d) => d.kind === 'Enum')).toMatchObject({ name: 'Stufe', variants: ['Gold', 'Silber'] });
    const driver = TYPES.decls.find((d) => d.name === 'Fahrer');
    expect(driver && 'fields' in driver ? driver.fields.map((f) => f.name) : []).toEqual(['alter', 'stufe', 'kinder', 'notiz']);
  });

  it('源码无法解析时返回 null', () => {
    expect(extractTypes({ source: 'Modul x.\n\nRegel kaputt gegeben', locale: 'de-DE', aliasSet: null }, undefined)).toBeNull();
  });

  it('同一版本重复提取命中缓存（返回同一组声明）', () => {
    const again = extractTypes({ source: DE_POLICY, locale: 'de-DE', aliasSet: null }, 'evaluate', (n) => (n === 'bewerten' ? 'evaluate' : n));
    expect(again!.decls).toBe(TYPES.decls);
    expect(again!.params.map((p) => p.name)).toEqual(['person']);
  });
});

describe('已知结构内映射 — 生产复现', () => {
  it('本地化输入 {"person":{"alter":21}} → {"person":{"age":21}}，并记录改写位置', () => {
    const result = mapExecutionInput({ person: { alter: 21 } }, MODEL);
    expect(result).toEqual({ ok: true, input: { person: { age: 21 } }, renames: [{ path: 'person.alter', from: 'alter', to: 'age' }] });
  });

  it('规范输入仍然接受、结果相同、无改写', () => {
    expect(mapExecutionInput({ person: { age: 21 } }, MODEL)).toEqual({ ok: true, input: { person: { age: 21 } }, renames: [] });
  });

  it('同一对象内本地化键与规范键并存 → 歧义，带字段路径与策略语言名', () => {
    expect(mapExecutionInput({ person: { alter: 21, age: 30 } }, MODEL)).toEqual({
      ok: false,
      ambiguous: { field: 'person.age', fields: ['person.alter', 'person.age'], policyName: 'alter' },
    });
  });

  it('两个同义词（本地化名 + 词汇别名）并存同样歧义', () => {
    expect(mapExecutionInput({ person: { alter: 21, lebensalter: 30 } }, MODEL).ok).toBe(false);
  });

  it('同义词单独使用时映射；匹配大小写不敏感（与执行端规范化一致）', () => {
    expect(mapped({ person: { Lebensalter: 21 } })).toEqual({ person: { age: 21 } });
    expect(mapped({ person: { ALTER: 21 } })).toEqual({ person: { age: 21 } });
  });

  it('结构内未知键原样保留（连同其值）', () => {
    expect(mapped({ person: { alter: 21, extra: { alter: 1 } } })).toEqual({ person: { age: 21, extra: { alter: 1 } } });
  });

  it('结构列表逐项映射，歧义路径带下标', () => {
    expect(mapped({ person: { kinder: [{ alter: 3 }, { age: 5 }] } })).toEqual({ person: { children: [{ age: 3 }, { age: 5 }] } });
    const result = mapExecutionInput({ person: { kinder: [{ alter: 3 }, { alter: 4, age: 5 }] } }, MODEL);
    expect(result.ok ? null : result.ambiguous.field).toBe('person.kinder[1].age');
  });

  it('枚举字段的策略语言值 → 规范值；规范值仍然接受；非成员原样', () => {
    expect(mapped({ person: { stufe: 'Gold' } })).toEqual({ person: { tier: 'GOLD' } });
    expect(mapped({ person: { stufe: 'SILVER' } })).toEqual({ person: { tier: 'SILVER' } });
    expect(mapped({ person: { stufe: 'Platin' } })).toEqual({ person: { tier: 'Platin' } });
  });

  it('非枚举字段（Text）里的同名文本不改写', () => {
    expect(mapped({ person: { notiz: 'Gold' } })).toEqual({ person: { notiz: 'Gold' } });
  });

  it('类型标签 __type 指向已知结构：标签与字段都映射', () => {
    const model = buildMappingModel(INDEX, { params: [{ name: 'x', type: T('Unknown') }], decls: TYPES.decls });
    expect(mapped({ x: { __type: 'Fahrer', stufe: 'Silber' } }, model)).toEqual({ x: { __type: 'Driver', tier: 'SILVER' } });
  });

  it('数组形式的位置参数按参数位置取类型', () => {
    expect(mapped([{ alter: 9, stufe: 'Gold' }])).toEqual([{ age: 9, tier: 'GOLD' }]);
  });

  it('__proto__ 键作为普通自有属性保留，不污染原型', () => {
    const out = mapped(JSON.parse('{"person":{"__proto__":{"polluted":true},"alter":1}}')) as { person: Record<string, unknown> };
    expect(Object.prototype.hasOwnProperty.call(out.person, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('类型未知处一律原样', () => {
  it('参数名原样，未知参数（不在入口函数参数里）的值不动', () => {
    expect(mapped({ fahrer: { alter: 1 }, person: { alter: 2 } })).toEqual({ fahrer: { alter: 1 }, person: { age: 2 } });
  });

  it('类型提取失败：整个输入原样透传', () => {
    const model = buildMappingModel(INDEX, null);
    expect(mapExecutionInput({ person: { alter: 1, age: 2 } }, model)).toEqual({ ok: true, input: { person: { alter: 1, age: 2 } }, renames: [] });
  });

  it('未声明的类型（Unknown / 外部类型）与原始类型字段里的对象不动', () => {
    const types: PolicyInputTypes = {
      params: [{ name: 'a', type: T('Unknown') }, { name: 'b', type: T('Text') }],
      decls: TYPES.decls,
    };
    expect(mapped({ a: { alter: 1, stufe: 'Gold' }, b: { alter: 2 } }, buildMappingModel(INDEX, types)))
      .toEqual({ a: { alter: 1, stufe: 'Gold' }, b: { alter: 2 } });
  });

  it('Map 的键是数据；值类型为原始类型时值也不动；值类型为结构时才映射值内部', () => {
    const types: PolicyInputTypes = {
      params: [
        { name: 'noten', type: { kind: 'Map', key: T('Text'), val: T('Int') } },
        { name: 'leute', type: { kind: 'Map', key: T('Text'), val: T('Fahrer') } },
        { name: 'stufen', type: { kind: 'Map', key: T('Text'), val: T('Stufe') } },
      ],
      decls: TYPES.decls,
    };
    expect(mapped({ noten: { alter: 1 }, leute: { alter: { alter: 3 } }, stufen: { alter: 'Gold' } }, buildMappingModel(INDEX, types)))
      .toEqual({ noten: { alter: 1 }, leute: { alter: { age: 3 } }, stufen: { alter: 'GOLD' } });
  });

  it('列表元素类型未知时元素不动', () => {
    const types: PolicyInputTypes = { params: [{ name: 'xs', type: { kind: 'List', type: T('Unknown') } }], decls: TYPES.decls };
    expect(mapped({ xs: [{ alter: 1 }] }, buildMappingModel(INDEX, types))).toEqual({ xs: [{ alter: 1 }] });
  });
});

describe('写法撞名（按结构作用域）', () => {
  const PERSON = (fields: string[]): PolicyInputTypes => ({
    params: [{ name: 'p', type: T('Person') }],
    decls: [{ kind: 'Data', name: 'Person', fields: fields.map((name) => ({ name, type: T('Int') })) }],
  });

  it('两个字段的本地化名大小写折叠后相同：该写法不映射、输入用到它时 400 带候选，其它键照常', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const index = buildVocabularyNameIndex(vocab([
      row('field', 'height', 'Größe', 'Person'),
      row('field', 'size', 'größe', 'Person'),
      row('field', 'age', 'alter', 'Person'),
    ]));
    const model = buildMappingModel(index, PERSON(['Größe', 'alter']));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('struct Person'), expect.arrayContaining(['größe']));
    expect(mapExecutionInput({ p: { größe: 1 } }, model)).toEqual({
      ok: false,
      ambiguous: { field: 'p.größe', fields: ['p.größe'], policyName: 'größe', candidates: ['height', 'size'] },
    });
    expect(mapped({ p: { alter: 1, size: 2 } }, model)).toEqual({ p: { age: 1, size: 2 } });
  });

  it('规范名等于另一字段的本地化名：该写法撞名', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const index = buildVocabularyNameIndex(vocab([
      row('field', 'age', 'alter', 'Person'),
      row('field', 'level', 'age', 'Person'),
    ]));
    const model = buildMappingModel(index, PERSON(['alter', 'stufe']));
    const result = mapExecutionInput({ p: { age: 1 } }, model);
    expect(result.ok ? null : result.ambiguous.candidates).toEqual(['age', 'level']);
    expect(mapped({ p: { alter: 1 } }, model)).toEqual({ p: { age: 1 } });
  });

  it('同一个本地化词在不同结构里各有所指：不算撞名', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const index = buildVocabularyNameIndex(vocab([
      row('field', 'grade', 'stufe', 'Student'),
      row('field', 'tier', 'stufe', 'Customer'),
    ]));
    // 引擎是上下文无关替换（后写覆盖），源码里两个 stufe 都会变成同一个规范名；这里只验证按结构
    // 作用域建表不会因此误报撞名，映射结果与引擎看到的字段名一致。
    const model = buildMappingModel(index, {
      params: [{ name: 's', type: T('Student') }, { name: 'c', type: T('Customer') }],
      decls: [
        { kind: 'Data', name: 'Student', fields: [{ name: 'stufe', type: T('Int') }] },
        { kind: 'Data', name: 'Customer', fields: [{ name: 'stufe', type: T('Int') }] },
      ],
    });
    const out = mapped({ s: { stufe: 1 }, c: { stufe: 2 } }, model) as Record<string, Record<string, number>>;
    expect(Object.keys(out.s!)).toEqual(Object.keys(out.c!));
    // 引擎把被抢走的那个结构里的 stufe 也规范成同一个名字：只记警告，不报歧义。
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('resolves to'));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('collisions'), expect.anything());
  });

  it('枚举成员撞名：值用到它时 400', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const index = buildVocabularyNameIndex(vocab([
      row('enum_value', 'GOLD', 'Gold', 'Tier'),
      row('enum_value', 'GOLDEN', 'gold', 'Tier'),
    ]));
    const model = buildMappingModel(index, {
      params: [{ name: 't', type: T('Tier') }],
      decls: [{ kind: 'Enum', name: 'Tier', variants: ['Gold', 'GOLDEN'] }],
    });
    const result = mapExecutionInput({ t: 'gold' }, model);
    expect(result.ok ? null : result.ambiguous).toMatchObject({ field: 't', candidates: ['GOLD', 'GOLDEN'] });
  });
});

describe('无词汇 / 英文策略不受影响', () => {
  it('无词汇时输入原样返回（同一引用）', () => {
    const input = { person: { alter: 21, age: 30 } };
    const result = mapExecutionInput(input, buildMappingModel(null, TYPES));
    expect(result.ok && result.input).toBe(input);
  });

  it('空词汇或形状不对时不建索引；缺 kind 的快照条目按所在数组归类', () => {
    expect(buildVocabularyNameIndex(undefined)).toBeNull();
    expect(buildVocabularyNameIndex({ structs: [], fields: [] })).toBeNull();
    expect(buildVocabularyNameIndex('x')).toBeNull();
    expect(buildVocabularyNameIndex({ fields: [{ canonical: 'age', localized: 'alter' }] })).not.toBeNull();
  });

  it('字面量宏不参与输入映射', () => {
    expect(buildVocabularyNameIndex({ literals: [{ canonical: 'Text', localized: 'gruss', kind: 'literal' }] })).toBeNull();
  });
});

describe('输出本地化与函数名', () => {
  it('结果里的规范字段名与枚举值按返回类型还原为策略语言', () => {
    const model = buildMappingModel(INDEX, { ...TYPES, result: T('Fahrer') });
    expect(localizeExecutionOutput({ age: 3, tier: 'GOLD', other: 1 }, model)).toEqual({ alter: 3, stufe: 'Gold', other: 1 });
  });

  it('返回类型不是结构时原样', () => {
    expect(localizeExecutionOutput({ age: 3 }, MODEL)).toEqual({ age: 3 });
    expect(localizeExecutionOutput(42, MODEL)).toBe(42);
    expect(localizeExecutionOutput({ age: 3 }, null)).toEqual({ age: 3 });
  });

  // 引擎返回枚举值时是对象而不是字符串（#633）：{__type:'?', _enum, value, variant, args}
  const enumValue = (enumName: string, member: string) =>
    ({ __type: '?', _enum: enumName, value: member, variant: member, args: [] });

  it('返回类型是枚举、结果是枚举值对象：枚举名与成员名还原为策略语言，其余键原样', () => {
    const model = buildMappingModel(INDEX, { ...TYPES, result: T('Stufe') });
    expect(localizeExecutionOutput(enumValue('Tier', 'GOLD'), model)).toEqual(enumValue('Stufe', 'Gold'));
  });

  it('结构 / 列表里的枚举值对象递归还原', () => {
    const struct = buildMappingModel(INDEX, { ...TYPES, result: T('Fahrer') });
    expect(localizeExecutionOutput({ age: 3, tier: enumValue('Tier', 'SILVER') }, struct))
      .toEqual({ alter: 3, stufe: enumValue('Stufe', 'Silber') });
    const list = buildMappingModel(INDEX, { ...TYPES, result: { kind: 'List', type: T('Stufe') } });
    expect(localizeExecutionOutput([enumValue('Tier', 'GOLD'), 'SILVER'], list))
      .toEqual([enumValue('Stufe', 'Gold'), 'Silber']);
  });

  it('返回类型未知时按显式 _enum 标签认枚举；标签不认识或成员不在枚举里时原样', () => {
    expect(localizeExecutionOutput(enumValue('Tier', 'GOLD'), MODEL)).toEqual(enumValue('Stufe', 'Gold'));
    expect(localizeExecutionOutput([enumValue('Tier', 'GOLD')], MODEL)).toEqual([enumValue('Tier', 'GOLD')]);
    expect(localizeExecutionOutput(enumValue('Unknown', 'GOLD'), MODEL)).toEqual(enumValue('Unknown', 'GOLD'));
    expect(localizeExecutionOutput(enumValue('Tier', 'BRONZE'), MODEL)).toEqual(enumValue('Stufe', 'BRONZE'));
    expect(localizeExecutionOutput(enumValue('Tier', 'GOLD'), null)).toEqual(enumValue('Tier', 'GOLD'));
  });

  it('枚举值对象只认自身 _enum 标签：声明为枚举的字段里标签认不出时整个对象原样（两个方向都不猜）', () => {
    // 规则：运行时标签与声明类型矛盾时不按声明类型改写成员名，也不报歧义。
    const model = buildMappingModel(INDEX, { ...TYPES, result: T('Fahrer') });
    expect(localizeExecutionOutput({ age: 3, tier: enumValue('Unknown', 'GOLD') }, model))
      .toEqual({ alter: 3, stufe: enumValue('Unknown', 'GOLD') });
    expect(mapped({ person: { alter: 3, stufe: enumValue('Unknown', 'Gold') } }))
      .toEqual({ person: { age: 3, tier: enumValue('Unknown', 'Gold') } });
  });

  it('普通业务对象即使有 value / variant 键，没有 _enum 标签、也不是枚举类型时两个方向都不动', () => {
    const business = { value: 'GOLD', variant: 'SILVER', note: 'x' };
    const model = buildMappingModel(INDEX, { ...TYPES, result: T('Fahrer') });
    // notiz 是 Text 字段；顶层结果类型未知时同理
    expect(localizeExecutionOutput({ age: 3, notiz: business }, model)).toEqual({ alter: 3, notiz: business });
    expect(localizeExecutionOutput(business, MODEL)).toEqual(business);
    expect(mapped({ person: { alter: 3, notiz: { value: 'Gold', variant: 'Silber' } } }))
      .toEqual({ person: { age: 3, notiz: { value: 'Gold', variant: 'Silber' } } });
    expect(mapped({ other: { value: 'Gold', variant: 'Silber' } })).toEqual({ other: { value: 'Gold', variant: 'Silber' } });
  });

  it('输入方向：枚举值对象按同一写法表映射为引擎眼中的名字', () => {
    // 枚举名标签按引擎口径规范化：本词汇里 "stufe" 同时是字段 tier 的写法（引擎大小写不敏感、后写覆盖），
    // 所以引擎把类型名 Stufe 也读成 tier——映射与引擎保持一致。
    expect(mapped({ person: { alter: 3, stufe: enumValue('Stufe', 'Gold') } }))
      .toEqual({ person: { age: 3, tier: enumValue('tier', 'GOLD') } });
  });

  it('函数名按词汇规范化，规范名与未知名原样', () => {
    expect(mapFunctionName('bewerten', INDEX)).toBe('evaluate');
    expect(mapFunctionName('evaluate', INDEX)).toBe('evaluate');
    expect(mapFunctionName(undefined, INDEX)).toBeUndefined();
    expect(mapFunctionName('bewerten', null)).toBe('bewerten');
  });
});
