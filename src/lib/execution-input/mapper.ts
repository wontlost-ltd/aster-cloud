/**
 * 执行输入的领域词汇映射（#626，纯函数，无 I/O）。
 *
 * 产品规则：执行输入与策略语言一致——德语策略的输入写德语字段名（`{"person":{"alter":35}}`）。
 * 执行端（aster-api）规范化源码时按词汇把标识符 token（大小写不敏感，含别名）替换为规范名，
 * 引擎看到的字段 / 结构 / 枚举值都是规范名。这里在调用引擎前，**只在类型确定的位置**做同口径映射：
 *
 *   - 参数名（顶层键）来自源码，原样使用；
 *   - 对象只有在其类型是策略里声明的结构（或 `__type` 标签指向已知结构）时才映射字段键：
 *     策略写法 / 规范名 / 该字段词条的本地化名与同义词 → 规范名；
 *   - 枚举值只在字段类型是已声明枚举、且值是其成员时映射；运行时枚举对象
 *     （`{__type:'?', _enum, value, variant, args}`）同样只改 `_enum` / `value` / `variant`，
 *     其类型以 `_enum` 标签指向的已声明枚举为准（类型未知处也认这个显式标签）；
 *   - 类型未知（未知参数、未知字段、Text/Int 等、类型提取失败）、Map 的键：一律原样；
 *   - 同一对象内两个键指向同一字段 → 歧义；某个写法在该结构内同时对应多个字段（大小写折叠后
 *     撞名，或规范名等于另一字段的本地化名）→ 该写法不可映射，输入用到它时同样按歧义报错；
 *   - 结构内未知键原样保留。
 *
 * 写法表按结构（字段）/ 按枚举（成员）分别建立：同一个本地化词出现在不同结构里不算冲突。
 * 关键词别名（ADR 0022 aliasSet）只作用于源码关键词，不参与输入映射。
 * 同一套遍历也用于把结果里的规范名还原为策略语言（输出方向，不报歧义）。
 */

import {
  buildIdentifierIndex,
  IdentifierKind,
  type DomainVocabulary,
  type IdentifierMapping,
} from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';

/** 运行时类型标签键（Truffle/TS 运行时按它识别结构/变体）。 */
export const TYPE_TAG_KEY = '__type';

/** 运行时枚举值对象的枚举名标签键。 */
export const ENUM_TAG_KEY = '_enum';

/** 运行时枚举值对象里存放成员名的键（引擎两键同值，都要改写）。 */
const ENUM_MEMBER_KEYS = ['value', 'variant'] as const;

interface VocabTerm {
  readonly kind: IdentifierKind;
  readonly canonical: string;
  readonly spellings: readonly string[];
  readonly parent?: string;
}

/** 执行词汇的索引。 */
export interface VocabularyNameIndex {
  /** 与执行端相同口径的全局 本地化/别名（小写）→ 规范名（同键后写覆盖，镜像引擎），用于算引擎眼中的名字。 */
  readonly engineCanonical: ReadonlyMap<string, string>;
  /** 非字面量词条（按类别 + 父结构做同义词归属）。 */
  readonly terms: readonly VocabTerm[];
}

/** 策略类型节点（Core IR 的子集，只取输入映射用得到的形状）。 */
export type PolicyTypeNode =
  | { readonly kind: 'TypeName'; readonly name: string }
  | { readonly kind: 'List' | 'Maybe' | 'Option'; readonly type: PolicyTypeNode }
  | { readonly kind: 'Map'; readonly key: PolicyTypeNode; readonly val: PolicyTypeNode }
  | { readonly kind: 'PiiType'; readonly baseType: PolicyTypeNode }
  | { readonly kind: string };

export interface PolicyDataDecl {
  readonly kind: 'Data';
  readonly name: string;
  readonly fields: ReadonlyArray<{ readonly name: string; readonly type: PolicyTypeNode }>;
}

export interface PolicyEnumDecl {
  readonly kind: 'Enum';
  readonly name: string;
  readonly variants: readonly string[];
}

/** 从策略源码（未经词汇规范化，名字即作者所写）提取的参数与类型声明。 */
export interface PolicyInputTypes {
  /** 入口函数参数（按位置）。 */
  readonly params: ReadonlyArray<{ readonly name: string; readonly type: PolicyTypeNode }>;
  /** 入口函数返回类型（输出本地化用）。 */
  readonly result?: PolicyTypeNode;
  readonly decls: ReadonlyArray<PolicyDataDecl | PolicyEnumDecl>;
}

export interface AmbiguousInputField {
  /** 出问题的那个键的路径（如 `person.age`）。 */
  readonly field: string;
  /** 涉及的输入路径：两个键指向同一字段时为两者（先出现者在前）；写法撞名时只有它自己。 */
  readonly fields: readonly string[];
  /** 该字段在策略语言中的名字（写法撞名时为输入的写法）。 */
  readonly policyName: string;
  /** 写法撞名时它可能指向的规范名。 */
  readonly candidates?: readonly string[];
}

/** 一次映射改写了什么（secure-execute 审计用）。 */
export interface InputRename {
  readonly path: string;
  readonly from: string;
  readonly to: string;
}

export type MapInputResult =
  | { readonly ok: true; readonly input: unknown; readonly renames: readonly InputRename[] }
  | { readonly ok: false; readonly ambiguous: AmbiguousInputField };

/* ---------------------------------------------------------------- 词汇索引 */

const TERM_ARRAYS: ReadonlyArray<[string, IdentifierKind]> = [
  ['structs', IdentifierKind.STRUCT],
  ['fields', IdentifierKind.FIELD],
  ['functions', IdentifierKind.FUNCTION],
  ['enumValues', IdentifierKind.ENUM_VALUE],
];

/** 只保留 canonical/localized 为字符串的条目，kind 以所在数组为准（快照 JSON 可能缺 kind）。 */
function mappingsOf(value: unknown, kind: IdentifierKind): IdentifierMapping[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((m): m is IdentifierMapping =>
      !!m && typeof m === 'object' && typeof m.canonical === 'string' && typeof m.localized === 'string')
    .map((m) => ({ ...m, kind }));
}

function toTerm(m: IdentifierMapping): VocabTerm {
  const aliases = Array.isArray(m.aliases) ? m.aliases.filter((a): a is string => typeof a === 'string') : [];
  return { kind: m.kind, canonical: m.canonical, spellings: [m.localized, ...aliases], ...(m.parent ? { parent: m.parent } : {}) };
}

/**
 * 由执行词汇建索引；词汇为空或形状不对时返回 null（调用方按「无词汇」处理，输入原样透传）。
 * 字面量宏（literal）展开成字符串，不可能是字段名/枚举值，排除在外。
 */
export function buildVocabularyNameIndex(vocabulary: unknown): VocabularyNameIndex | null {
  if (!vocabulary || typeof vocabulary !== 'object') return null;
  const v = vocabulary as Record<string, unknown>;
  const byArray = TERM_ARRAYS.map(([key, kind]) => mappingsOf(v[key], kind));
  try {
    const index = buildIdentifierIndex({
      ...(v as unknown as DomainVocabulary),
      structs: byArray[0]!, fields: byArray[1]!, functions: byArray[2]!, enumValues: byArray[3]!, literals: [],
    });
    if (index.toCanonical.size === 0) return null;
    return { engineCanonical: index.toCanonical, terms: byArray.flat().map(toTerm) };
  } catch (err) {
    console.warn('[execution-input] malformed vocabulary; input passed through unchanged', err);
    return null;
  }
}

/** 引擎规范化后的名字：命中词汇（大小写不敏感）取规范名，否则原样。 */
export function engineName(index: VocabularyNameIndex, name: string): string {
  return index.engineCanonical.get(name.toLowerCase()) ?? name;
}

/* ---------------------------------------------------------------- 写法表 */

/**
 * 结构字段 / 枚举成员 / 结构本身：策略写法（source）与引擎规范名（target）。
 * 只出现在词汇里、源码未声明的词条也占一个槽位（declared=false）：不映射，只用于发现撞名。
 */
interface Slot {
  readonly source: string;
  readonly target: string;
  readonly declared: boolean;
  readonly type?: PolicyTypeNode;
}

/** 写法（小写）→ 可能指向的槽位；同一写法对应多个不同 target 即撞名。 */
type SpellingTable = ReadonlyMap<string, readonly Slot[]>;

type Lookup = { kind: 'none' } | { kind: 'one'; slot: Slot } | { kind: 'conflict'; targets: string[] };

function lookup(table: SpellingTable, key: string): Lookup {
  const slots = table.get(key.toLowerCase()) ?? [];
  if (slots.length === 0) return { kind: 'none' };
  if (slots.length > 1) return { kind: 'conflict', targets: slots.map((s) => s.target).sort() };
  return slots[0]!.declared ? { kind: 'one', slot: slots[0]! } : { kind: 'none' };
}

/** 作用域内的词条：类别相同、父结构（若词条声明了）一致。 */
function scopedTerms(index: VocabularyNameIndex, kind: IdentifierKind, parent: string | null): VocabTerm[] {
  return index.terms.filter((t) => t.kind === kind && (!t.parent || parent === null || t.parent === parent));
}

type TableEntry = { slot: Slot; spellings: readonly string[] };

/**
 * 某作用域（一个结构的字段 / 一个枚举的成员 / 全部结构名）的写法表条目：
 * 源码声明的每一项（策略写法 + 引擎规范名）加上作用域内全部词条（本地化名 + 同义词）。
 *
 * 词条归属：
 *   - 规范名与某声明项的引擎规范名相同 → 并入该声明项；
 *   - 否则若它的写法就是某声明项的策略写法，而该声明项的引擎规范名来自作用域**外**的词条
 *     （引擎上下文无关替换，同一个词被别的结构的词条抢走）→ 并入该声明项、以引擎为准，记警告；
 *     这正是「同一个词在不同结构里各有所指」，不算本作用域撞名；
 *   - 其余作为未声明槽位：不映射，只参与撞名检测（作用域内两个词条争同一写法即撞名）。
 */
function scopeEntries(scope: string, declared: readonly Slot[], terms: readonly VocabTerm[]): TableEntry[] {
  const entries: TableEntry[] = declared.map((slot) => ({ slot, spellings: [slot.source, slot.target] }));
  const inScope = (target: string) => terms.some((t) => t.canonical === target);
  for (const term of terms) {
    const shadowed = declared.find((slot) => !inScope(slot.target) && spells(term, slot.source));
    if (shadowed) {
      console.warn(`[execution-input] ${scope}: "${shadowed.source}" resolves to "${shadowed.target}" in the engine, not "${term.canonical}"`);
    }
    const owner = declared.find((slot) => slot.target === term.canonical) ?? shadowed;
    const slot = owner ?? { source: term.spellings[0]!, target: term.canonical, declared: false };
    entries.push({ slot, spellings: term.spellings });
  }
  return entries;
}

function spells(term: VocabTerm, written: string): boolean {
  const lower = written.toLowerCase();
  return term.spellings.some((s) => s.toLowerCase() === lower);
}

function buildTable(scope: string, entries: readonly TableEntry[]): SpellingTable {
  const table = new Map<string, Slot[]>();
  for (const { slot, spellings } of entries) {
    for (const spelling of spellings) {
      const key = spelling.toLowerCase();
      const slots = table.get(key) ?? [];
      if (!slots.some((s) => s.target === slot.target)) slots.push(slot);
      table.set(key, slots);
    }
  }
  const conflicts = [...table].filter(([, slots]) => slots.length > 1).map(([key]) => key);
  if (conflicts.length > 0) {
    console.warn(`[execution-input] vocabulary spelling collisions in ${scope}; these keys are not mapped`, conflicts);
  }
  return table;
}

interface StructModel {
  readonly kind: 'Data';
  readonly fields: SpellingTable;
}

interface EnumModel {
  readonly kind: 'Enum';
  readonly variants: SpellingTable;
}

/**
 * 一个版本的映射模型：按源码声明名索引的结构 / 枚举写法表，
 * 以及结构名写法表（`__type` 用）与枚举名写法表（`_enum` 用）。
 */
export interface MappingModel {
  readonly index: VocabularyNameIndex;
  readonly types: PolicyInputTypes;
  readonly byName: ReadonlyMap<string, StructModel | EnumModel>;
  readonly structs: SpellingTable;
  readonly enums: SpellingTable;
}

function structModel(index: VocabularyNameIndex, decl: PolicyDataDecl): StructModel {
  const declared = decl.fields.map((f) => ({ source: f.name, target: engineName(index, f.name), declared: true, type: f.type }));
  const terms = scopedTerms(index, IdentifierKind.FIELD, engineName(index, decl.name));
  return { kind: 'Data', fields: buildTable(`struct ${decl.name}`, scopeEntries(`struct ${decl.name}`, declared, terms)) };
}

function enumModel(index: VocabularyNameIndex, decl: PolicyEnumDecl): EnumModel {
  const declared = decl.variants.map((v) => ({ source: v, target: engineName(index, v), declared: true }));
  const terms = scopedTerms(index, IdentifierKind.ENUM_VALUE, engineName(index, decl.name));
  return { kind: 'Enum', variants: buildTable(`enum ${decl.name}`, scopeEntries(`enum ${decl.name}`, declared, terms)) };
}

/** 类型名写法表：源码声明的结构（或枚举）名 + 词汇里的类型名词条（枚举名在词汇里也记作 struct）。 */
function typeNameTable(index: VocabularyNameIndex, scope: string, decls: ReadonlyArray<{ name: string }>): SpellingTable {
  const declared = decls.map((d) => ({ source: d.name, target: engineName(index, d.name), declared: true }));
  return buildTable(scope, scopeEntries(scope, declared, scopedTerms(index, IdentifierKind.STRUCT, null)));
}

/** 建映射模型；无词汇时返回 null（输入原样）。类型取不到时传空类型：一切按未知类型原样透传。 */
export function buildMappingModel(index: VocabularyNameIndex | null, types: PolicyInputTypes | null): MappingModel | null {
  if (!index) return null;
  const effective: PolicyInputTypes = types ?? { params: [], decls: [] };
  const byName = new Map<string, StructModel | EnumModel>();
  for (const decl of effective.decls) {
    byName.set(decl.name, decl.kind === 'Data' ? structModel(index, decl) : enumModel(index, decl));
  }
  const structs = typeNameTable(index, 'struct names', effective.decls.filter((d) => d.kind === 'Data'));
  const enums = typeNameTable(index, 'enum names', effective.decls.filter((d) => d.kind === 'Enum'));
  return { index, types: effective, byName, structs, enums };
}

/* ---------------------------------------------------------------- 遍历 */

interface WalkContext {
  readonly model: MappingModel;
  readonly direction: 'input' | 'output';
  readonly renames: InputRename[];
}

type Walked = { ok: true; value: unknown } | { ok: false; ambiguous: AmbiguousInputField };

const PASS = (value: unknown): Walked => ({ ok: true, value });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function joinPath(parent: string, key: string): string {
  return parent === '' ? key : `${parent}.${key}`;
}

/** 解开 Pii/Maybe/Option 包装，得到真正描述值形状的类型。 */
function unwrapType(type: PolicyTypeNode | undefined): PolicyTypeNode | undefined {
  let current = type;
  while (current && ['PiiType', 'Maybe', 'Option'].includes(current.kind)) {
    current = 'baseType' in current ? current.baseType : (current as { type: PolicyTypeNode }).type;
  }
  return current;
}

function conflict(path: string, written: string, targets: string[]): Walked {
  return { ok: false, ambiguous: { field: path, fields: [path], policyName: written, candidates: targets } };
}

/** 按方向把查到的槽位换成输出写法；输出方向撞名时不改。 */
function rewrite(ctx: WalkContext, found: Lookup, written: string, path: string): Walked {
  if (found.kind === 'none') return PASS(written);
  if (found.kind === 'conflict') return ctx.direction === 'input' ? conflict(path, written, found.targets) : PASS(written);
  const out = ctx.direction === 'input' ? found.slot.target : found.slot.source;
  if (out !== written && ctx.direction === 'input') ctx.renames.push({ path, from: written, to: out });
  return PASS(out);
}

type TypeModel = StructModel | EnumModel;

type TagResolution = { ok: true; model: TypeModel | undefined; tag: unknown } | { ok: false; ambiguous: AmbiguousInputField };

/**
 * 按运行时类型标签（`__type` / `_enum`）解析对象的实际类型：标签指向已声明类型时以它为准，
 * 否则用声明类型；标签本身按方向改写。table 只含同一类声明（结构名表 / 枚举名表），查到的必是同类。
 */
function resolveTag(
  ctx: WalkContext,
  value: Record<string, unknown>,
  tagKey: string,
  table: SpellingTable,
  declared: TypeModel | undefined,
  path: string,
): TagResolution {
  const tag = value[tagKey];
  if (typeof tag !== 'string') return { ok: true, model: declared, tag };
  const found = lookup(table, tag);
  const rewritten = rewrite(ctx, found, tag, joinPath(path, tagKey));
  if (!rewritten.ok) return rewritten;
  const tagged = found.kind === 'one' ? ctx.model.byName.get(found.slot.source) : undefined;
  return { ok: true, model: tagged ?? declared, tag: rewritten.value };
}

function walkStruct(ctx: WalkContext, value: Record<string, unknown>, declared: StructModel | undefined, path: string): Walked {
  const resolved = resolveTag(ctx, value, TYPE_TAG_KEY, ctx.model.structs, declared, path);
  if (!resolved.ok) return resolved;
  if (resolved.model?.kind !== 'Data') return PASS(value);
  const fields = resolved.model.fields;
  const seen = new Map<string, string>();
  const entries: Array<[string, unknown]> = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = joinPath(path, key);
    const found = key === TYPE_TAG_KEY ? null : lookup(fields, key);
    if (!found || found.kind === 'none') {
      entries.push([key, key === TYPE_TAG_KEY ? resolved.tag : child]);
      continue;
    }
    const renamed = rewrite(ctx, found, key, childPath);
    if (!renamed.ok) return renamed;
    const outKey = String(renamed.value);
    const prior = seen.get(outKey);
    if (prior !== undefined) return duplicate(prior, childPath, found);
    seen.set(outKey, childPath);
    const walked = walkValue(ctx, child, found.kind === 'one' ? found.slot.type : undefined, childPath);
    if (!walked.ok) return walked;
    entries.push([outKey, walked.value]);
  }
  // Object.fromEntries 以自有属性写入，`__proto__` 之类的键不会污染原型。
  return PASS(Object.fromEntries(entries));
}

/** 运行时枚举值对象：带枚举名标签，且成员名至少在 value / variant 之一。 */
function isEnumObject(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && typeof value[ENUM_TAG_KEY] === 'string'
    && ENUM_MEMBER_KEYS.some((key) => typeof value[key] === 'string');
}

/** 枚举值对象只改写枚举名标签与成员名，其余键（`__type`、`args` 等）原样。 */
function walkEnumObject(ctx: WalkContext, value: Record<string, unknown>, declared: EnumModel | undefined, path: string): Walked {
  const resolved = resolveTag(ctx, value, ENUM_TAG_KEY, ctx.model.enums, declared, path);
  if (!resolved.ok) return resolved;
  if (resolved.model?.kind !== 'Enum') return PASS(value);
  const variants = resolved.model.variants;
  const out: Record<string, unknown> = { ...value, [ENUM_TAG_KEY]: resolved.tag };
  for (const key of ENUM_MEMBER_KEYS) {
    const member = value[key];
    if (typeof member !== 'string') continue;
    const rewritten = rewrite(ctx, lookup(variants, member), member, joinPath(path, key));
    if (!rewritten.ok) return rewritten;
    out[key] = rewritten.value;
  }
  return PASS(out);
}

/** 同一对象内两个键落到同一字段：输入方向报歧义；输出方向不会发生（规范键唯一）。 */
function duplicate(prior: string, path: string, found: Lookup): Walked {
  const policyName = found.kind === 'one' ? found.slot.source : path;
  return { ok: false, ambiguous: { field: path, fields: [prior, path], policyName } };
}

function walkArray(ctx: WalkContext, items: readonly unknown[], elementType: PolicyTypeNode, path: string): Walked {
  const out: unknown[] = [];
  for (const [i, item] of items.entries()) {
    const walked = walkValue(ctx, item, elementType, `${path}[${i}]`);
    if (!walked.ok) return walked;
    out.push(walked.value);
  }
  return PASS(out);
}

/** Map<K,V>：键是数据不是字段名，原样保留；只按值类型映射值。 */
function walkMap(ctx: WalkContext, value: Record<string, unknown>, valType: PolicyTypeNode, path: string): Walked {
  const entries: Array<[string, unknown]> = [];
  for (const [key, child] of Object.entries(value)) {
    const walked = walkValue(ctx, child, valType, joinPath(path, key));
    if (!walked.ok) return walked;
    entries.push([key, walked.value]);
  }
  return PASS(Object.fromEntries(entries));
}

/** 声明类型是已声明枚举时取其模型。 */
function declaredEnum(ctx: WalkContext, type: PolicyTypeNode | undefined): EnumModel | undefined {
  if (type?.kind !== 'TypeName' || !('name' in type)) return undefined;
  const decl = ctx.model.byName.get(type.name);
  return decl?.kind === 'Enum' ? decl : undefined;
}

/** 按类型递归映射一个值；类型未知或与值形状不符时原样返回。 */
function walkValue(ctx: WalkContext, value: unknown, rawType: PolicyTypeNode | undefined, path: string): Walked {
  const type = unwrapType(rawType);
  if (isEnumObject(value)) return walkEnumObject(ctx, value, declaredEnum(ctx, type), path);
  if (!type) return PASS(value);
  if (type.kind === 'List' && Array.isArray(value)) return walkArray(ctx, value, (type as { type: PolicyTypeNode }).type, path);
  if (type.kind === 'Map' && isPlainObject(value)) return walkMap(ctx, value, (type as { val: PolicyTypeNode }).val, path);
  if (type.kind !== 'TypeName' || !('name' in type)) return PASS(value);
  const decl = ctx.model.byName.get(type.name);
  if (isPlainObject(value)) return walkStruct(ctx, value, decl?.kind === 'Data' ? decl : undefined, path);
  if (typeof value === 'string' && decl?.kind === 'Enum') return rewrite(ctx, lookup(decl.variants, value), value, path);
  return PASS(value);
}

/* ---------------------------------------------------------------- 入口 */

function walkParams(ctx: WalkContext, input: unknown): Walked {
  const params = ctx.model.types.params;
  if (Array.isArray(input)) {
    const out: unknown[] = [];
    for (const [i, arg] of input.entries()) {
      const walked = walkValue(ctx, arg, params[i]?.type, params[i]?.name ?? `[${i}]`);
      if (!walked.ok) return walked;
      out.push(walked.value);
    }
    return PASS(out);
  }
  if (!isPlainObject(input)) return PASS(input);
  // 参数名来自源码，原样使用；只映射已知类型参数值的内部。
  const entries: Array<[string, unknown]> = [];
  for (const [name, arg] of Object.entries(input)) {
    const walked = walkValue(ctx, arg, params.find((p) => p.name === name)?.type, name);
    if (!walked.ok) return walked;
    entries.push([name, walked.value]);
  }
  return PASS(Object.fromEntries(entries));
}

/**
 * 把执行输入从策略语言映射为引擎所需的规范名。
 *
 * @param input 请求里的输入（对象：按参数名；数组：按参数位置）
 * @param model 映射模型；null 表示该版本无词汇，输入原样返回
 */
export function mapExecutionInput(input: unknown, model: MappingModel | null): MapInputResult {
  if (!model) return { ok: true, input, renames: [] };
  const ctx: WalkContext = { model, direction: 'input', renames: [] };
  const walked = walkParams(ctx, input);
  return walked.ok ? { ok: true, input: walked.value, renames: ctx.renames } : walked;
}

/** 把引擎结果里的规范名还原为策略语言（按入口函数返回类型），供界面展示；不报歧义。 */
export function localizeExecutionOutput(value: unknown, model: MappingModel | null): unknown {
  if (!model) return value;
  const walked = walkValue({ model, direction: 'output', renames: [] }, value, model.types.result, '');
  return walked.ok ? walked.value : value;
}

/** 函数名与源码标识符同口径规范化（规范名仍然接受）。 */
export function mapFunctionName(name: string | undefined, index: VocabularyNameIndex | null): string | undefined {
  if (!name || !index) return name;
  return engineName(index, name);
}
