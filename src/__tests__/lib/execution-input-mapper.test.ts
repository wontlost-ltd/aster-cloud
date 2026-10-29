/**
 * #626 执行输入映射：只在类型确定的位置把策略语言字段名 / 枚举值 / 类型标签映射为规范名。
 *
 * ADR 0051：类型表来自引擎 resolvePolicyTypes（按位置解析后的规范名 + 作者写法），写法表按结构（字段）/
 * 按枚举（成员）分别建立，同义词取自引擎的 VocabularyScopes。词汇与生产复现一致（e2e1027/de：
 * Driver→Fahrer、age→alter、Tier→Stufe 与 tier→stufe 并存）。撞名等边界用真实德语源码构造。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assembleDomainVocabularyFromLinks, type TermLikeRow } from '@/lib/domain-vocabulary-assemble';
import {
  buildExecutionVocabulary,
  buildMappingModel,
  localizeExecutionOutput,
  mapExecutionInput,
  type ExecutionVocabulary,
  type PolicyInputTypes,
  type PolicyTypeNode,
} from '@/lib/execution-input/mapper';
import { clearPolicyInputTypesCache, extractPolicyInputTypes } from '@/lib/execution-input/policy-types';

function row(kind: string, canonical: string, localized: string, parent: string | null = null, aliases: string[] = []): TermLikeRow {
  return { domainTermId: `${kind}-${canonical}-${localized}`, domain: 'e2e1027', locale: 'de', kind, canonical, localized, parentCanonical: parent, aliases };
}

function execVocab(rows: TermLikeRow[]): ExecutionVocabulary {
  return buildExecutionVocabulary(assembleDomainVocabularyFromLinks(rows, { domain: 'e2e1027', locale: 'de-DE' }))!;
}

/** 用真实引擎提取类型；失败时抛出（用例只关心成功路径）。 */
function typesOf(source: string, vocabulary: ExecutionVocabulary, functionName?: string): PolicyInputTypes {
  const result = extractPolicyInputTypes({ source, locale: 'de-DE', aliasSet: null, vocabulary }, functionName);
  if (!result.ok) throw new Error(`type extraction failed: ${JSON.stringify(result)}`);
  return result.types;
}

const BASE_ROWS = [
  row('struct', 'Driver', 'Fahrer'),
  row('struct', 'Child', 'Kind'),
  row('field', 'age', 'alter', 'Driver', ['lebensalter']),
  row('field', 'age', 'alter', 'Child'),
  row('field', 'children', 'kinder', 'Driver'),
  row('field', 'tier', 'stufe', 'Driver'),
  row('struct', 'Tier', 'Stufe'),
  row('enum_value', 'GOLD', 'Gold', 'Tier'),
  row('enum_value', 'SILVER', 'Silber', 'Tier'),
  row('function', 'evaluate', 'bewerten'),
];
const VOCAB = execVocab(BASE_ROWS);

// ADR 0051 §1 复现：类型 Stufe（Tier）与字段 stufe（tier）只差大小写。
const DE_POLICY = `Modul e2e1027.vocab.

Definiere Stufe als eines von Gold, Silber.

Definiere Kind hat alter als Ganzzahl.

Definiere Fahrer hat alter als Ganzzahl, stufe als Stufe, kinder als List of Kind, notiz als Text.

Regel bewerten gegeben person als Fahrer liefert Ganzzahl:
  wenn person.alter mindestens 18:
    gib zurück 42.
  gib zurück 0.
`;
const TYPES = typesOf(DE_POLICY, VOCAB);
const MODEL = buildMappingModel(VOCAB, TYPES);

const T = (name: string): PolicyTypeNode => ({ kind: 'TypeName', name });

function mapped(input: unknown, model = MODEL) {
  const result = mapExecutionInput(input, model);
  if (!result.ok) throw new Error(`unexpected ambiguity: ${JSON.stringify(result.ambiguous)}`);
  return result.input;
}

afterEach(() => {
  vi.restoreAllMocks();
  clearPolicyInputTypesCache();
});

describe('引擎类型表（ADR 0051）', () => {
  it('结构 / 字段 / 枚举 / 参数类型都是按位置解析后的规范名，并保留作者写法', () => {
    expect(TYPES.params).toEqual([{ name: 'person', type: { kind: 'TypeName', name: 'Driver' } }]);
    expect(TYPES.enums).toEqual([{
      canonical: 'Tier', written: 'Stufe',
      members: [{ canonical: 'GOLD', written: 'Gold' }, { canonical: 'SILVER', written: 'Silber' }],
    }]);
    const driver = TYPES.structs.find((s) => s.canonical === 'Driver')!;
    expect(driver.fields.map((f) => [f.written, f.canonical])).toEqual([
      ['alter', 'age'], ['stufe', 'tier'], ['kinder', 'children'], ['notiz', 'notiz'],
    ]);
    expect(driver.fields[1]!.type).toEqual({ kind: 'TypeName', name: 'Tier' });
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

  it('同义词单独使用时映射；大小写折叠后唯一也映射', () => {
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

  it('ADR 0051 §1：字段 stufe 与类型 Stufe 各按位置映射——枚举值 → 规范值；规范值仍然接受；非成员原样', () => {
    expect(mapped({ person: { stufe: 'Gold' } })).toEqual({ person: { tier: 'GOLD' } });
    expect(mapped({ person: { stufe: 'SILVER' } })).toEqual({ person: { tier: 'SILVER' } });
    expect(mapped({ person: { stufe: 'Platin' } })).toEqual({ person: { tier: 'Platin' } });
  });

  it('非枚举字段（Text）里的同名文本不改写', () => {
    expect(mapped({ person: { notiz: 'Gold' } })).toEqual({ person: { notiz: 'Gold' } });
  });

  it('类型标签 __type 指向已知结构：标签与字段都映射', () => {
    const model = buildMappingModel(VOCAB, { ...TYPES, params: [{ name: 'x', type: T('Unknown') }] });
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
    const model = buildMappingModel(VOCAB, null);
    expect(mapExecutionInput({ person: { alter: 1, age: 2 } }, model)).toEqual({ ok: true, input: { person: { alter: 1, age: 2 } }, renames: [] });
  });

  it('未声明的类型（Unknown / 外部类型）与原始类型字段里的对象不动', () => {
    const types: PolicyInputTypes = { ...TYPES, params: [{ name: 'a', type: T('Unknown') }, { name: 'b', type: T('Text') }] };
    expect(mapped({ a: { alter: 1, stufe: 'Gold' }, b: { alter: 2 } }, buildMappingModel(VOCAB, types)))
      .toEqual({ a: { alter: 1, stufe: 'Gold' }, b: { alter: 2 } });
  });

  it('Map 的键是数据；值类型为原始类型时值也不动；值类型为结构时才映射值内部', () => {
    const types: PolicyInputTypes = {
      ...TYPES,
      params: [
        { name: 'noten', type: { kind: 'Map', key: T('Text'), val: T('Int') } },
        { name: 'leute', type: { kind: 'Map', key: T('Text'), val: T('Driver') } },
        { name: 'stufen', type: { kind: 'Map', key: T('Text'), val: T('Tier') } },
      ],
    };
    expect(mapped({ noten: { alter: 1 }, leute: { alter: { alter: 3 } }, stufen: { alter: 'Gold' } }, buildMappingModel(VOCAB, types)))
      .toEqual({ noten: { alter: 1 }, leute: { alter: { age: 3 } }, stufen: { alter: 'GOLD' } });
  });

  it('列表元素类型未知时元素不动', () => {
    const types: PolicyInputTypes = { ...TYPES, params: [{ name: 'xs', type: { kind: 'List', type: T('Unknown') } }] };
    expect(mapped({ xs: [{ alter: 1 }] }, buildMappingModel(VOCAB, types))).toEqual({ xs: [{ alter: 1 }] });
  });

  it('Review Focus 5：R2 定不了类型的嵌套对象（Text 字段里的对象、未知 __type）原样透传、不报错', () => {
    const source = `Modul e2e1027.nested.

Definiere Fahrer hat alter als Ganzzahl, extra als Text.

Regel bewerten gegeben person als Fahrer, anhang als Text liefert Ganzzahl:
  gib zurück person.alter.
`;
    const model = buildMappingModel(VOCAB, typesOf(source, VOCAB));
    const nested = { alter: 1, stufe: 'Gold', __type: 'Unbekannt', tiefer: { alter: 2 } };
    expect(mapExecutionInput({ person: { alter: 3, extra: nested }, anhang: nested }, model)).toEqual({
      ok: true,
      input: { person: { age: 3, extra: nested }, anhang: nested },
      renames: [{ path: 'person.alter', from: 'alter', to: 'age' }],
    });
  });
});

describe('写法撞名（按结构作用域，精确优先、折叠后多候选才歧义）', () => {
  it('两个字段写法只差大小写：精确写法各自映射；只能折叠匹配时 400 带候选，其它键照常', () => {
    const vocab = execVocab([
      row('struct', 'Person', 'Person'),
      row('field', 'maxValue', 'maxWert', 'Person'),
      row('field', 'maxRate', 'maxwert', 'Person'),
      row('field', 'age', 'alter', 'Person'),
    ]);
    const source = `Modul m.

Definiere Person hat maxWert als Ganzzahl, maxwert als Ganzzahl, alter als Ganzzahl.

Regel messen gegeben p als Person liefert Ganzzahl:
  gib zurück p.alter.
`;
    const model = buildMappingModel(vocab, typesOf(source, vocab));
    expect(mapped({ p: { maxWert: 1, maxwert: 2, alter: 3 } }, model)).toEqual({ p: { maxValue: 1, maxRate: 2, age: 3 } });
    expect(mapExecutionInput({ p: { MAXWERT: 1 } }, model)).toEqual({
      ok: false,
      ambiguous: { field: 'p.MAXWERT', fields: ['p.MAXWERT'], policyName: 'MAXWERT', candidates: ['maxRate', 'maxValue'] },
    });
  });

  it('规范名等于另一字段的写法：该写法精确命中两个字段 → 撞名', () => {
    const vocab = execVocab([
      row('struct', 'Person', 'Person'),
      row('field', 'age', 'alter', 'Person'),
      row('field', 'level', 'age', 'Person'),
    ]);
    const source = `Modul m.

Definiere Person hat alter als Ganzzahl, age als Ganzzahl.

Regel messen gegeben p als Person liefert Ganzzahl:
  gib zurück p.alter.
`;
    const model = buildMappingModel(vocab, typesOf(source, vocab));
    const result = mapExecutionInput({ p: { age: 1 } }, model);
    expect(result.ok ? null : result.ambiguous.candidates).toEqual(['age', 'level']);
    expect(mapped({ p: { alter: 1, level: 2 } }, model)).toEqual({ p: { age: 1, level: 2 } });
  });

  it('同一个本地化词在不同结构里各有所指：按所属结构分别映射，不算撞名', () => {
    const vocab = execVocab([
      row('struct', 'Student', 'Schueler'),
      row('struct', 'Customer', 'Kunde'),
      row('field', 'grade', 'stufe', 'Student'),
      row('field', 'tier', 'stufe', 'Customer'),
    ]);
    const source = `Modul m.

Definiere Schueler hat stufe als Ganzzahl.

Definiere Kunde hat stufe als Ganzzahl.

Regel vergleichen gegeben s als Schueler, c als Kunde liefert Ganzzahl:
  gib zurück s.stufe.
`;
    const model = buildMappingModel(vocab, typesOf(source, vocab));
    expect(mapped({ s: { stufe: 1 }, c: { stufe: 2 } }, model)).toEqual({ s: { grade: 1 }, c: { tier: 2 } });
  });

  it('枚举成员只差大小写：精确写法各自映射，只能折叠匹配时 400', () => {
    const vocab = execVocab([
      row('struct', 'Tier', 'Rang'),
      row('enum_value', 'GOLD', 'Gold', 'Tier'),
      row('enum_value', 'GOLDEN', 'gold', 'Tier'),
    ]);
    const source = `Modul m.

Definiere Rang als eines von Gold, gold.

Regel pruefen gegeben t als Rang liefert Rang:
  gib zurück t.
`;
    const model = buildMappingModel(vocab, typesOf(source, vocab));
    expect(mapped({ t: 'gold' }, model)).toEqual({ t: 'GOLDEN' });
    expect(mapped({ t: 'Gold' }, model)).toEqual({ t: 'GOLD' });
    const result = mapExecutionInput({ t: 'GoLd' }, model);
    expect(result.ok ? null : result.ambiguous).toMatchObject({ field: 't', candidates: ['GOLD', 'GOLDEN'] });
  });
});

describe('无词汇 / 英文策略不受影响', () => {
  it('无词汇时输入原样返回（同一引用）', () => {
    const input = { person: { alter: 21, age: 30 } };
    const result = mapExecutionInput(input, buildMappingModel(null, TYPES));
    expect(result.ok && result.input).toBe(input);
  });

  it('空词汇或形状不对时不建；缺 kind 的快照条目按所在数组归类', () => {
    expect(buildExecutionVocabulary(undefined)).toBeNull();
    expect(buildExecutionVocabulary({ structs: [], fields: [] })).toBeNull();
    expect(buildExecutionVocabulary('x')).toBeNull();
    expect(buildExecutionVocabulary({ fields: [{ canonical: 'age', localized: 'alter', parent: 'Driver' }] })).not.toBeNull();
  });

  it('字面量宏不参与输入映射', () => {
    expect(buildExecutionVocabulary({ literals: [{ canonical: 'Text', localized: 'gruss', kind: 'literal' }] })).toBeNull();
  });

  it('引擎拒绝的词汇（字段缺所属结构）：记告警、按无词汇处理', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(buildExecutionVocabulary({ fields: [{ canonical: 'age', localized: 'alter' }] })).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed vocabulary'), expect.anything());
  });
});

describe('输出本地化', () => {
  it('结果里的规范字段名与枚举值按返回类型还原为策略语言', () => {
    const model = buildMappingModel(VOCAB, { ...TYPES, result: T('Driver') });
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
    const model = buildMappingModel(VOCAB, { ...TYPES, result: T('Tier') });
    expect(localizeExecutionOutput(enumValue('Tier', 'GOLD'), model)).toEqual(enumValue('Stufe', 'Gold'));
  });

  it('结构 / 列表里的枚举值对象递归还原', () => {
    const struct = buildMappingModel(VOCAB, { ...TYPES, result: T('Driver') });
    expect(localizeExecutionOutput({ age: 3, tier: enumValue('Tier', 'SILVER') }, struct))
      .toEqual({ alter: 3, stufe: enumValue('Stufe', 'Silber') });
    const list = buildMappingModel(VOCAB, { ...TYPES, result: { kind: 'List', type: T('Tier') } });
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
    const model = buildMappingModel(VOCAB, { ...TYPES, result: T('Driver') });
    expect(localizeExecutionOutput({ age: 3, tier: enumValue('Unknown', 'GOLD') }, model))
      .toEqual({ alter: 3, stufe: enumValue('Unknown', 'GOLD') });
    expect(mapped({ person: { alter: 3, stufe: enumValue('Unknown', 'Gold') } }))
      .toEqual({ person: { age: 3, tier: enumValue('Unknown', 'Gold') } });
  });

  it('普通业务对象即使有 value / variant 键，没有 _enum 标签、也不是枚举类型时两个方向都不动', () => {
    const business = { value: 'GOLD', variant: 'SILVER', note: 'x' };
    const model = buildMappingModel(VOCAB, { ...TYPES, result: T('Driver') });
    expect(localizeExecutionOutput({ age: 3, notiz: business }, model)).toEqual({ alter: 3, notiz: business });
    expect(localizeExecutionOutput(business, MODEL)).toEqual(business);
    expect(mapped({ person: { alter: 3, notiz: { value: 'Gold', variant: 'Silber' } } }))
      .toEqual({ person: { age: 3, notiz: { value: 'Gold', variant: 'Silber' } } });
    expect(mapped({ other: { value: 'Gold', variant: 'Silber' } })).toEqual({ other: { value: 'Gold', variant: 'Silber' } });
  });

  it('输入方向：枚举值对象的 _enum 标签按类型名映射（ADR 0051 §1：Stufe 是类型 Tier，不再被字段 stufe 抢走）', () => {
    expect(mapped({ person: { alter: 3, stufe: enumValue('Stufe', 'Gold') } }))
      .toEqual({ person: { age: 3, tier: enumValue('Tier', 'GOLD') } });
  });
});
