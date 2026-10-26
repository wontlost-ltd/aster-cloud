/**
 * 执行输入的领域词汇映射（#626，纯函数，无 I/O）。
 *
 * 产品规则：执行输入与策略语言一致——德语策略的输入写德语字段名（`{"person":{"alter":35}}`）。
 * 执行端（aster-api）规范化源码时按词汇把**每个**标识符 token（大小写不敏感，含别名）上下文无关地
 * 替换为规范名，所以引擎看到的字段/结构/枚举值都是规范名。这里在调用引擎前对输入做同口径映射：
 *
 *   - 参数名（顶层键）来自源码，原样使用，不映射；
 *   - 字段名（嵌套对象的键）：本地化名 / 别名 → 规范名；规范名仍然接受；
 *   - 枚举值：仅当该字段的类型确定是枚举、且值是该枚举某个成员（本地化名 / 别名 / 规范名）时映射；
 *     无类型信息时不动值，避免把普通文本误当枚举改写；
 *   - 类型标签 `__type` 的值：结构名本地化 → 规范；
 *   - 同一对象内两个键映射到同一规范名 → 歧义，调用方返回 400 ambiguous_input_field，不猜测；
 *   - 未知键原样保留（与修复前行为一致）。
 *
 * 关键词别名（ADR 0022 aliasSet）只作用于源码关键词，不参与输入映射。
 * 同一套遍历也用于把结果里的规范名还原为策略语言（输出方向，不做歧义报错）。
 */

import {
  buildIdentifierIndex,
  IdentifierKind,
  type DomainVocabulary,
  type IdentifierMapping,
} from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';

/** 运行时类型标签键（Truffle/TS 运行时按它识别结构/变体）。 */
export const TYPE_TAG_KEY = '__type';

/** 输入映射需要的词汇索引：本地化/别名（小写）→ 规范名，规范名（小写）→ 本地化名。 */
export interface VocabularyNameIndex {
  readonly toCanonical: ReadonlyMap<string, string>;
  readonly toLocalized: ReadonlyMap<string, string>;
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
  /** 后出现的那个键的路径（如 `person.age`）。 */
  readonly field: string;
  /** 冲突的两个键的路径（先出现者在前）。 */
  readonly fields: readonly [string, string];
  /** 两者共同指向的规范名。 */
  readonly canonical: string;
  /** 该字段在策略语言中的名字（用于错误提示）。 */
  readonly policyName: string;
}

export type MapInputResult =
  | { readonly ok: true; readonly input: unknown }
  | { readonly ok: false; readonly ambiguous: AmbiguousInputField };

/**
 * 由执行词汇建索引；词汇为空或形状不对时返回 null（调用方按「无词汇」处理，输入原样透传）。
 * 字面量宏（literal）展开成字符串，不可能是字段名/枚举值，排除在外。
 */
export function buildVocabularyNameIndex(vocabulary: unknown): VocabularyNameIndex | null {
  if (!vocabulary || typeof vocabulary !== 'object') return null;
  const v = vocabulary as Record<string, unknown>;
  try {
    const index = buildIdentifierIndex({
      ...(v as unknown as DomainVocabulary),
      structs: mappingsOf(v.structs, IdentifierKind.STRUCT),
      fields: mappingsOf(v.fields, IdentifierKind.FIELD),
      functions: mappingsOf(v.functions, IdentifierKind.FUNCTION),
      enumValues: mappingsOf(v.enumValues, IdentifierKind.ENUM_VALUE),
      literals: [],
    });
    return index.toCanonical.size === 0 ? null : { toCanonical: index.toCanonical, toLocalized: index.toLocalized };
  } catch (err) {
    console.warn('[execution-input] malformed vocabulary; input passed through unchanged', err);
    return null;
  }
}

/** 只保留 canonical/localized 为字符串的条目，kind 以所在数组为准（快照 JSON 可能缺 kind）。 */
function mappingsOf(value: unknown, kind: IdentifierKind): IdentifierMapping[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((m): m is IdentifierMapping =>
      !!m && typeof m === 'object' && typeof m.canonical === 'string' && typeof m.localized === 'string')
    .map((m) => ({ ...m, kind }));
}

/** 与执行端规范化同口径：命中词汇（大小写不敏感）则取规范名，否则原样。 */
export function canonicalName(index: VocabularyNameIndex, name: string): string {
  return index.toCanonical.get(name.toLowerCase()) ?? name;
}

/** 规范名 → 策略语言名；无映射时原样。 */
function localizedName(index: VocabularyNameIndex, name: string): string {
  return index.toLocalized.get(name.toLowerCase()) ?? name;
}

type Decl = PolicyDataDecl | PolicyEnumDecl;

/** 一次映射的上下文：词汇索引、按规范名索引的类型声明、方向。 */
interface WalkContext {
  readonly index: VocabularyNameIndex;
  readonly decls: ReadonlyMap<string, Decl>;
  readonly direction: 'input' | 'output';
}

type Walked = { ok: true; value: unknown } | { ok: false; ambiguous: AmbiguousInputField };

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

function declOf(ctx: WalkContext, type: PolicyTypeNode | undefined): Decl | undefined {
  if (!type || type.kind !== 'TypeName' || !('name' in type)) return undefined;
  return ctx.decls.get(canonicalName(ctx.index, type.name));
}

/** 带类型标签的对象按标签指向的结构解析（标签值可为本地化或规范结构名）。 */
function taggedDecl(ctx: WalkContext, value: Record<string, unknown>, fallback: Decl | undefined): Decl | undefined {
  const tag = value[TYPE_TAG_KEY];
  if (typeof tag !== 'string') return fallback;
  return ctx.decls.get(canonicalName(ctx.index, tag)) ?? fallback;
}

/** 枚举值：仅当是该枚举的成员时换成目标方向的写法。 */
function mapEnumValue(ctx: WalkContext, decl: PolicyEnumDecl, value: string): string {
  const canonical = canonicalName(ctx.index, value);
  const variant = decl.variants.find((v) => canonicalName(ctx.index, v) === canonical);
  if (variant === undefined) return value;
  return ctx.direction === 'input' ? canonical : variant;
}

/** 字段键：返回规范名（用于找字段类型）与输出键（按方向）。 */
function mapKey(ctx: WalkContext, key: string, decl: Decl | undefined) {
  const canonical = canonicalName(ctx.index, key);
  const field = decl?.kind === 'Data'
    ? decl.fields.find((f) => canonicalName(ctx.index, f.name) === canonical)
    : undefined;
  if (ctx.direction === 'input') return { canonical, out: canonical, field };
  return { canonical, out: field?.name ?? localizedName(ctx.index, key), field };
}

function mapTypeTag(ctx: WalkContext, tag: unknown): unknown {
  if (typeof tag !== 'string') return tag;
  const canonical = canonicalName(ctx.index, tag);
  if (ctx.direction === 'input') return canonical;
  return ctx.decls.get(canonical)?.name ?? localizedName(ctx.index, tag);
}

function walkObject(ctx: WalkContext, value: Record<string, unknown>, decl: Decl | undefined, path: string): Walked {
  const effective = taggedDecl(ctx, value, decl);
  const seen = new Map<string, string>();
  const entries: Array<[string, unknown]> = [];
  for (const [key, child] of Object.entries(value)) {
    if (key === TYPE_TAG_KEY) {
      entries.push([key, mapTypeTag(ctx, child)]);
      continue;
    }
    const mapped = mapKey(ctx, key, effective);
    const childPath = joinPath(path, key);
    const prior = seen.get(mapped.out);
    if (prior !== undefined && ctx.direction === 'input') {
      const policyName = mapped.field?.name ?? localizedName(ctx.index, mapped.canonical);
      return { ok: false, ambiguous: { field: childPath, fields: [prior, childPath], canonical: mapped.canonical, policyName } };
    }
    // 输出方向撞名时保留原键，宁可不本地化也不丢值。
    const outKey = prior === undefined ? mapped.out : key;
    seen.set(outKey, childPath);
    const walked = walkValue(ctx, child, mapped.field?.type, childPath);
    if (!walked.ok) return walked;
    entries.push([outKey, walked.value]);
  }
  // Object.fromEntries 以自有属性写入，`__proto__` 之类的键不会污染原型。
  return { ok: true, value: Object.fromEntries(entries) };
}

function walkArray(ctx: WalkContext, items: readonly unknown[], elementType: PolicyTypeNode | undefined, path: string): Walked {
  const out: unknown[] = [];
  for (const [i, item] of items.entries()) {
    const walked = walkValue(ctx, item, elementType, `${path}[${i}]`);
    if (!walked.ok) return walked;
    out.push(walked.value);
  }
  return { ok: true, value: out };
}

/** Map<K,V>：键是数据不是字段名，原样保留；只按值类型映射值。 */
function walkMap(ctx: WalkContext, value: Record<string, unknown>, valType: PolicyTypeNode, path: string): Walked {
  const entries: Array<[string, unknown]> = [];
  for (const [key, child] of Object.entries(value)) {
    const walked = walkValue(ctx, child, valType, joinPath(path, key));
    if (!walked.ok) return walked;
    entries.push([key, walked.value]);
  }
  return { ok: true, value: Object.fromEntries(entries) };
}

/** 按类型（可能未知）递归映射一个值。 */
function walkValue(ctx: WalkContext, value: unknown, rawType: PolicyTypeNode | undefined, path: string): Walked {
  const type = unwrapType(rawType);
  if (Array.isArray(value)) {
    const elementType = type?.kind === 'List' ? (type as { type: PolicyTypeNode }).type : undefined;
    return walkArray(ctx, value, elementType, path);
  }
  if (isPlainObject(value) && type?.kind === 'Map') {
    return walkMap(ctx, value, (type as { val: PolicyTypeNode }).val, path);
  }
  const decl = declOf(ctx, type);
  if (isPlainObject(value)) return walkObject(ctx, value, decl, path);
  if (typeof value === 'string' && decl?.kind === 'Enum') {
    return { ok: true, value: mapEnumValue(ctx, decl, value) };
  }
  return { ok: true, value };
}

function contextOf(index: VocabularyNameIndex, types: PolicyInputTypes | null, direction: WalkContext['direction']): WalkContext {
  const decls = new Map<string, Decl>();
  for (const decl of types?.decls ?? []) decls.set(canonicalName(index, decl.name), decl);
  return { index, decls, direction };
}

/**
 * 把执行输入从策略语言映射为引擎所需的规范名。
 *
 * @param input 请求里的输入（对象：按参数名；数组：按参数位置）
 * @param index 执行词汇索引；null 表示该版本无词汇，输入原样返回
 * @param types 策略参数/类型声明；null 表示取不到（只映射字段键与类型标签，不动枚举值）
 */
export function mapExecutionInput(
  input: unknown,
  index: VocabularyNameIndex | null,
  types: PolicyInputTypes | null,
): MapInputResult {
  if (!index) return { ok: true, input };
  const ctx = contextOf(index, types, 'input');
  const params = types?.params ?? [];
  if (Array.isArray(input)) {
    const out: unknown[] = [];
    for (const [i, arg] of input.entries()) {
      const walked = walkValue(ctx, arg, params[i]?.type, params[i]?.name ?? `[${i}]`);
      if (!walked.ok) return walked;
      out.push(walked.value);
    }
    return { ok: true, input: out };
  }
  if (!isPlainObject(input)) return { ok: true, input };
  // 参数名来自源码，原样使用；只映射参数值内部。
  const entries: Array<[string, unknown]> = [];
  for (const [name, arg] of Object.entries(input)) {
    const walked = walkValue(ctx, arg, params.find((p) => p.name === name)?.type, name);
    if (!walked.ok) return walked;
    entries.push([name, walked.value]);
  }
  return { ok: true, input: Object.fromEntries(entries) };
}

/**
 * 把引擎结果里的规范名还原为策略语言（字段键、枚举值、类型标签），供界面展示。
 * 不做歧义报错；无词汇时原样返回。
 */
export function localizeExecutionOutput(
  value: unknown,
  index: VocabularyNameIndex | null,
  types: PolicyInputTypes | null,
): unknown {
  if (!index) return value;
  const walked = walkValue(contextOf(index, types, 'output'), value, types?.result, '');
  return walked.ok ? walked.value : value;
}

/** 函数名与源码标识符同口径规范化（规范名仍然接受）。 */
export function mapFunctionName(name: string | undefined, index: VocabularyNameIndex | null): string | undefined {
  if (!name || !index) return name;
  return canonicalName(index, name);
}
