/**
 * 执行输入的领域词汇映射（#626，纯函数，无 I/O）。
 *
 * 产品规则：执行输入与策略语言一致——德语策略的输入写德语字段名（`{"person":{"alter":35}}`）。
 * 引擎按位置解析标识符（ADR 0051），执行时看到的字段 / 结构 / 枚举值都是规范名。类型表直接取自
 * 引擎 `resolvePolicyTypes`（规范名 + 作者写法），这里在调用引擎前**只在类型确定的位置**映射：
 *
 *   - 参数名（顶层键）是源码局部名，原样使用；
 *   - 对象只有在其类型是策略里声明的结构（或 `__type` 标签指向已知结构）时才映射字段键：
 *     作者写法 / 规范名 / 该结构下该字段词条的本地化名与同义词 → 规范名；
 *   - 枚举值只在字段类型是已声明枚举、且值是其成员时映射；运行时枚举对象
 *     （`{__type:'?', _enum, value, variant, args}`）同样只改 `_enum` / `value` / `variant`，
 *     其类型只以自身 `_enum` 标签为准：标签指向已声明枚举才改写（类型未知处也认这个显式标签），
 *     认不出的标签整个对象原样透传，不按声明类型去猜；没有 `_enum` 标签的对象不算枚举值；
 *   - 类型未知（未知参数、未知字段、Text/Int 等、引擎定不了的类型）、Map 的键：一律原样；
 *   - 写法匹配与引擎同口径（ADR 0051 §6.3）：先 NFC 精确匹配，再大小写折叠匹配；同一层命中多个
 *     不同字段 → 该写法歧义，输入用到它时报错；同一对象内两个键指向同一字段 → 歧义；
 *   - 结构内未知键原样保留。
 *
 * 写法表按结构（字段）/ 按枚举（成员）分别建立：同一个本地化词在不同结构里各有所指不算冲突。
 * 关键词别名（ADR 0022 aliasSet）只作用于源码关键词，不参与输入映射。
 * 同一套遍历也用于把结果里的规范名还原为作者写法（输出方向，不报歧义）。
 */

import {
  buildVocabularyScopes,
  foldKey,
  IdentifierKind,
  type Candidate,
  type DomainVocabulary,
  type IdentifierMapping,
  type PolicyTypes,
  type VocabularyScopes,
} from '@aster-cloud/aster-lang-ts/browser';

/** 运行时类型标签键（Truffle/TS 运行时按它识别结构/变体）。 */
export const TYPE_TAG_KEY = '__type';

/** 运行时枚举值对象的枚举名标签键。 */
export const ENUM_TAG_KEY = '_enum';

/** 运行时枚举值对象里存放成员名的键（引擎两键同值，都要改写）。 */
const ENUM_MEMBER_KEYS = ['value', 'variant'] as const;

/** 执行词汇：规整后的词汇（交给引擎解析类型）与引擎的按位置作用域视图（同义词来源）。 */
export interface ExecutionVocabulary {
  readonly vocabulary: DomainVocabulary;
  readonly scopes: VocabularyScopes;
}

/** 策略类型节点（Core IR 类型的子集，只取输入映射用得到的形状；名字均为规范名）。 */
export type PolicyTypeNode =
  | { readonly kind: 'TypeName'; readonly name: string }
  | { readonly kind: 'List' | 'Maybe' | 'Option'; readonly type: PolicyTypeNode }
  | { readonly kind: 'Map'; readonly key: PolicyTypeNode; readonly val: PolicyTypeNode }
  | { readonly kind: 'PiiType'; readonly baseType: PolicyTypeNode }
  | { readonly kind: string };

/** 入口函数的参数与返回类型，加上引擎解析出的结构 / 枚举声明。 */
export interface PolicyInputTypes {
  /** 入口函数参数（按位置；参数名为源码写法）。 */
  readonly params: ReadonlyArray<{ readonly name: string; readonly type: PolicyTypeNode }>;
  /** 入口函数返回类型（输出本地化用）。 */
  readonly result?: PolicyTypeNode;
  readonly structs: PolicyTypes['structs'];
  readonly enums: PolicyTypes['enums'];
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

/* ---------------------------------------------------------------- 执行词汇 */

/** 词条数组键与其类别：快照 JSON 可能缺数组或缺条目的 kind，按所在数组补齐。 */
const TERM_ARRAYS: ReadonlyArray<readonly [string, IdentifierKind]> = [
  ['structs', IdentifierKind.STRUCT],
  ['fields', IdentifierKind.FIELD],
  ['functions', IdentifierKind.FUNCTION],
  ['enumValues', IdentifierKind.ENUM_VALUE],
  ['literals', IdentifierKind.LITERAL],
];

/** 只保留 canonical/localized 为字符串的条目，kind 以所在数组为准。 */
export function mappingsOf(value: unknown, kind: IdentifierKind): IdentifierMapping[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((m): m is IdentifierMapping =>
      !!m && typeof m === 'object' && typeof m.canonical === 'string' && typeof m.localized === 'string')
    .map((m) => ({ ...m, kind }));
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value ? value : fallback;
}

/**
 * 由执行词汇建引擎作用域；没有任何标识符词条（字面量宏不算，它展开成字符串，不可能是字段名 /
 * 枚举值）或引擎拒绝该词汇时返回 null（调用方按「无词汇」处理，输入原样透传）。
 */
export function buildExecutionVocabulary(raw: unknown): ExecutionVocabulary | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  const arrays = Object.fromEntries(TERM_ARRAYS.map(([key, kind]) => [key, mappingsOf(v[key], kind)]));
  const identifiers = TERM_ARRAYS.filter(([, kind]) => kind !== IdentifierKind.LITERAL);
  if (identifiers.every(([key]) => arrays[key]!.length === 0)) return null;
  const vocabulary = {
    ...arrays,
    id: text(v.id, 'user-vocabulary'),
    name: text(v.name, text(v.id, 'user-vocabulary')),
    locale: text(v.locale, ''),
    version: text(v.version, 'user'),
  } as unknown as DomainVocabulary;
  try {
    return { vocabulary, scopes: buildVocabularyScopes(vocabulary) };
  } catch (err) {
    console.warn('[execution-input] malformed vocabulary; input passed through unchanged', err);
    return null;
  }
}

/* ---------------------------------------------------------------- 写法表 */

/** 一个声明项（结构字段 / 枚举成员 / 类型 / 函数）：规范名、作者写法，字段另带类型。 */
export interface Slot {
  readonly canonical: string;
  readonly written: string;
  readonly type?: PolicyTypeNode;
}

/** 写法 → 声明项：NFC 精确键与折叠键各一张；规范名 → 声明项供输出方向直接还原。 */
export interface SpellingTable {
  readonly exact: ReadonlyMap<string, readonly Slot[]>;
  readonly folded: ReadonlyMap<string, readonly Slot[]>;
  readonly byCanonical: ReadonlyMap<string, Slot>;
}

export type Lookup = { kind: 'none' } | { kind: 'one'; slot: Slot } | { kind: 'conflict'; targets: string[] };

function addSpelling(table: Map<string, Slot[]>, key: string, slot: Slot): void {
  const slots = table.get(key) ?? [];
  if (!slots.some((s) => s.canonical === slot.canonical)) slots.push(slot);
  table.set(key, slots);
}

/**
 * 某作用域（一个结构的字段 / 一个枚举的成员 / 全部类型名 / 全部函数）的写法表：
 * 每个声明项接受作者写法、规范名，以及作用域内规范名与之相同的词条写法（本地化名与同义词）。
 * 只认引擎解析出的声明项：词汇里有、策略里没声明的词条不参与，也就不会制造假撞名。
 */
export function buildSpellingTable(slots: readonly Slot[], candidates: readonly Candidate[]): SpellingTable {
  const exact = new Map<string, Slot[]>();
  const folded = new Map<string, Slot[]>();
  for (const slot of slots) {
    const synonyms = candidates.filter((c) => c.canonical === slot.canonical).map((c) => c.written);
    for (const spelling of [slot.written, slot.canonical, ...synonyms]) {
      addSpelling(exact, spelling.normalize('NFC'), slot);
      addSpelling(folded, foldKey(spelling), slot);
    }
  }
  return { exact, folded, byCanonical: new Map(slots.map((s) => [s.canonical, s])) };
}

function lookupSlots(slots: readonly Slot[] | undefined): Lookup | null {
  if (!slots || slots.length === 0) return null;
  if (slots.length === 1) return { kind: 'one', slot: slots[0]! };
  return { kind: 'conflict', targets: slots.map((s) => s.canonical).sort() };
}

/** 与引擎同口径：NFC 精确匹配优先，其次折叠匹配；同一层多个不同规范名即撞名。 */
export function lookupSpelling(table: SpellingTable, key: string): Lookup {
  return lookupSlots(table.exact.get(key.normalize('NFC')))
    ?? lookupSlots(table.folded.get(foldKey(key)))
    ?? { kind: 'none' };
}

/** 折叠索引里的全部候选（按父名分组的取该组）。 */
export function candidatesOf(index: ReadonlyMap<string, Candidate[]> | undefined): Candidate[] {
  return index ? [...index.values()].flat() : [];
}

interface StructModel {
  readonly kind: 'Data';
  readonly fields: SpellingTable;
}

interface EnumModel {
  readonly kind: 'Enum';
  readonly members: SpellingTable;
}

type TypeModel = StructModel | EnumModel;

/**
 * 一个版本的映射模型：按规范名索引的结构 / 枚举写法表，
 * 以及结构名写法表（`__type` 用）与枚举名写法表（`_enum` 用）。
 */
export interface MappingModel {
  readonly types: PolicyInputTypes;
  readonly byName: ReadonlyMap<string, TypeModel>;
  readonly structs: SpellingTable;
  readonly enums: SpellingTable;
}

/** 建映射模型；无词汇时返回 null（输入原样）。类型取不到时传空类型：一切按未知类型原样透传。 */
export function buildMappingModel(vocab: ExecutionVocabulary | null, types: PolicyInputTypes | null): MappingModel | null {
  if (!vocab) return null;
  const { scopes } = vocab;
  const effective: PolicyInputTypes = types ?? { params: [], structs: [], enums: [] };
  const byName = new Map<string, TypeModel>();
  for (const s of effective.structs) {
    byName.set(s.canonical, { kind: 'Data', fields: buildSpellingTable(s.fields, candidatesOf(scopes.fields.get(s.canonical))) });
  }
  for (const e of effective.enums) {
    byName.set(e.canonical, { kind: 'Enum', members: buildSpellingTable(e.members, candidatesOf(scopes.enumMembers.get(e.canonical))) });
  }
  const typeCandidates = candidatesOf(scopes.types);
  return {
    types: effective,
    byName,
    structs: buildSpellingTable(effective.structs, typeCandidates),
    enums: buildSpellingTable(effective.enums, typeCandidates),
  };
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

/** 按方向查写法：输入按写法表（精确优先、再折叠），输出按规范名直接还原。 */
function find(ctx: WalkContext, table: SpellingTable, key: string): Lookup {
  if (ctx.direction === 'input') return lookupSpelling(table, key);
  const slot = table.byCanonical.get(key);
  return slot ? { kind: 'one', slot } : { kind: 'none' };
}

/** 按方向把查到的声明项换成输出写法（输入 → 规范名，输出 → 作者写法）。 */
function rewrite(ctx: WalkContext, found: Lookup, written: string, path: string): Walked {
  if (found.kind === 'none') return PASS(written);
  if (found.kind === 'conflict') return conflict(path, written, found.targets);
  const out = ctx.direction === 'input' ? found.slot.canonical : found.slot.written;
  if (out !== written && ctx.direction === 'input') ctx.renames.push({ path, from: written, to: out });
  return PASS(out);
}

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
  const found = find(ctx, table, tag);
  const rewritten = rewrite(ctx, found, tag, joinPath(path, tagKey));
  if (!rewritten.ok) return rewritten;
  const tagged = found.kind === 'one' ? ctx.model.byName.get(found.slot.canonical) : undefined;
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
    const found = key === TYPE_TAG_KEY ? null : find(ctx, fields, key);
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

/**
 * 枚举值对象只改写枚举名标签与成员名，其余键（`__type`、`args` 等）原样。
 * 类型只认对象自带的 `_enum` 标签（不传声明类型）：标签认不出时整个对象原样透传——
 * 运行时标签与声明类型矛盾时不猜测。
 */
function walkEnumObject(ctx: WalkContext, value: Record<string, unknown>, path: string): Walked {
  const resolved = resolveTag(ctx, value, ENUM_TAG_KEY, ctx.model.enums, undefined, path);
  if (!resolved.ok) return resolved;
  if (resolved.model?.kind !== 'Enum') return PASS(value);
  const members = resolved.model.members;
  const out: Record<string, unknown> = { ...value, [ENUM_TAG_KEY]: resolved.tag };
  for (const key of ENUM_MEMBER_KEYS) {
    const member = value[key];
    if (typeof member !== 'string') continue;
    const rewritten = rewrite(ctx, find(ctx, members, member), member, joinPath(path, key));
    if (!rewritten.ok) return rewritten;
    out[key] = rewritten.value;
  }
  return PASS(out);
}

/** 同一对象内两个键落到同一字段：输入方向报歧义；输出方向不会发生（规范键唯一）。 */
function duplicate(prior: string, path: string, found: Lookup): Walked {
  const policyName = found.kind === 'one' ? found.slot.written : path;
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

/** 按类型递归映射一个值；类型未知或与值形状不符时原样返回。 */
function walkValue(ctx: WalkContext, value: unknown, rawType: PolicyTypeNode | undefined, path: string): Walked {
  const type = unwrapType(rawType);
  if (isEnumObject(value)) return walkEnumObject(ctx, value, path);
  if (!type) return PASS(value);
  if (type.kind === 'List' && Array.isArray(value)) return walkArray(ctx, value, (type as { type: PolicyTypeNode }).type, path);
  if (type.kind === 'Map' && isPlainObject(value)) return walkMap(ctx, value, (type as { val: PolicyTypeNode }).val, path);
  if (type.kind !== 'TypeName' || !('name' in type)) return PASS(value);
  const decl = ctx.model.byName.get(type.name);
  if (isPlainObject(value)) return walkStruct(ctx, value, decl?.kind === 'Data' ? decl : undefined, path);
  if (typeof value === 'string' && decl?.kind === 'Enum') return rewrite(ctx, find(ctx, decl.members, value), value, path);
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
