/**
 * 执行输入的打码视图（cloud#754，ADR 0042 §12 F9）。纯函数，无 I/O。
 *
 * 执行日志对策略可见者展示输入时，口径与审批收件箱一致：
 *   - 分类（声明树 + `@pii` 标记）与 aster-api `InputClassifier`（replay 模块）同一推导，取被执行版本 Core IR 中
 *     入口 Rule 的参数类型。执行输入就是 `{ 参数名: 值 }`，所以路径前缀是参数名（aster-api 证据形状是
 *     `context.<键>`，这里没有外层 `context`）；
 *   - 打码与 aster-api `InputViewRenderer` 同一规则（§11 D2 表格、递归与路径规则，§12 D4）：
 *     已声明无 `@pii` 明文（字符串再过一遍与 aster-api `PIIRedactor` 相同的正则，规范 UUID 豁免）；
 *     `@pii` 替换为 `{ $pii: { level, category } }`；形状不符或超过深度 8 的值替换为 `{ $pii: { level: 'unknown' } }`。
 *   - 未声明的键（多出的键、源码未标注类型的字段、非参数的顶层键）：比 aster-api 视图更严——键名也不展示
 *     （§11 D2「未声明的键名本身可能是 PII」），同一对象里的全部未声明键合并为一项
 *     `{ [UNDECLARED_KEY]: { $pii: { level: 'unknown' } } }`。aster-api `InputViewRenderer` 目前仍展示这类键名。
 *
 * 为什么在 cloud 推导而不是调 aster-api 视图：aster-api 只为 REQUIRE_APPROVAL / ESCALATE 决策存输入
 * （§11 D1），日志里绝大多数执行（ALLOW / DENY / 值输出）在 api 侧没有可取的视图。cloud 用同一引擎
 * （aster-lang-ts，与 Java 前端的类型结果由 aster-lang-test parity 锁定）对已保存版本推导，规则以本文件与
 * 对应测试为唯一实现，与 aster-api 的测试用例逐条对照。
 *
 * 日志面不提供解除：原值只经审批面的解除端点返回（按人入链，§12 D5）。
 */

import { createHash } from 'node:crypto';
import {
  buildVocabularyScopes,
  canonicalScopesJson,
  parseSource,
  resolveAndLowerChecked,
  type DomainVocabulary,
  type ResolvedCore,
  type VocabularyScopes,
} from '@aster-cloud/aster-lang-ts/browser';
import { getLexicon } from '@/lib/aster-lexicon';
import { UNDECLARED_KEY } from './pii-placeholder';

export { UNDECLARED_KEY };

/** 打码规则版本，与 aster-api `InputViewRenderer.MASK_RULES` 同值；规则变化须两边一起升版。 */
export const INPUT_MASK_RULES = 'v1';
/** 嵌套深度上限：输入根为第 1 层（对应 aster-api 的 `context`）。 */
const MAX_DEPTH = 8;
/** 声明叶子上限（ADR 0042 §12 D7）。 */
const MAX_DECLARED = 512;
const PII_KEY = '$pii';

export interface PiiMark {
  readonly path: string;
  readonly level: string;
  readonly category: string;
  readonly source: 'ir';
}

/** 声明树（每个已声明叶子路径）与其中带 `@pii` 的叶子标记；`declared ⊇ marks.path`。 */
export interface InputClassification {
  readonly declared: readonly string[];
  readonly marks: readonly PiiMark[];
}

/** 分类来源：`version` = 由被执行版本推导；`none` = 取不到（全部业务值按 unknown 打码）。 */
export type InputMarksSource = 'version' | 'none';

/** 日志行随输入下发的打码说明。 */
export interface ExecutionInputMask {
  readonly maskRules: typeof INPUT_MASK_RULES;
  readonly marksSource: InputMarksSource;
}

/* ---------------------------------------------------------------- 分类 */

const PRIMITIVES = new Set(['Int', 'Bool', 'Long', 'Double', 'Decimal', 'String', 'Text', 'Number', 'Verdict']);

/** Core IR 类型（包入口不导出 Core 命名空间，从 resolveAndLowerChecked 的返回类型取）。 */
type CoreModule = ResolvedCore['core'];
type CoreDecl = CoreModule['decls'][number];
type CoreData = Extract<CoreDecl, { kind: 'Data' }>;
type CoreFunc = Extract<CoreDecl, { kind: 'Func' }>;
type CoreType = CoreData['fields'][number]['type'];
type CorePiiType = Extract<CoreType, { kind: 'PiiType' }>;

function unwrap(type: CoreType): { type: CoreType; pii: CorePiiType | null } {
  let pii: CorePiiType | null = null;
  let t = type;
  for (;;) {
    if (t.kind === 'PiiType') {
      pii ??= t;
      t = t.baseType;
    } else if (t.kind === 'Option' || t.kind === 'Maybe') {
      t = t.type;
    } else {
      return { type: t, pii };
    }
  }
}

/** 非空、不含点与方括号、不含控制字符：否则路径无法无歧义地拆回键（同 aster-api `representableKey`）。 */
function representableKey(key: string): boolean {
  return key.length > 0 && !/[.[\]\u0000-\u001f]/.test(key);
}

class ClassificationWalker {
  private readonly records = new Map<string, CoreData>();
  private readonly enums = new Set<string>();
  private readonly expanding = new Set<string>();
  private readonly declared = new Set<string>();
  private readonly marks = new Map<string, PiiMark>();
  private overflow = false;

  constructor(module: CoreModule) {
    for (const d of module.decls) {
      if (d.kind === 'Data') this.records.set(d.name, d);
      else if (d.kind === 'Enum') this.enums.add(d.name);
    }
  }

  result(): InputClassification | null {
    if (this.overflow) return null;
    const sorted = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    return {
      declared: [...this.declared].sort(sorted),
      marks: [...this.marks.values()].sort((a, b) => sorted(a.path, b.path)),
    };
  }

  /** depth 为 path 所在的记录层数（参数自身为 0）。 */
  walk(type: CoreType, path: string, depth: number): void {
    if (this.overflow) return;
    const { type: base, pii } = unwrap(type);
    if (base.kind === 'List') return this.walkList(base.type, path, depth, pii);
    if (base.kind === 'TypeApp' && base.base === 'List' && base.args.length === 1) {
      return this.walkList(base.args[0]!, path, depth, pii);
    }
    if (base.kind !== 'TypeName') return; // Map、类型变量、函数类型：不进声明树
    const record = this.records.get(base.name);
    if (record && !pii) return this.walkRecord(record, path, depth);
    // 基础类型 / 枚举是叶子；@pii 包住记录类型时整个子树作为一个打码叶子
    if (this.isLeafType(base.name) || pii) this.leaf(path, pii);
  }

  private walkList(element: CoreType, path: string, depth: number, listPii: CorePiiType | null): void {
    const e = unwrap(element);
    const record = e.type.kind === 'TypeName' ? this.records.get(e.type.name) : undefined;
    if (!listPii && !e.pii && record) return this.walkRecord(record, `${path}[]`, depth);
    const leafType = e.type.kind === 'TypeName' && this.isLeafType(e.type.name);
    if (listPii || e.pii || leafType) this.leaf(path, listPii ?? e.pii);
  }

  private walkRecord(record: CoreData, path: string, depth: number): void {
    if (depth + 1 > MAX_DEPTH) {
      this.overflow = true;
      return;
    }
    if (this.expanding.has(record.name)) return; // 环：该字段不进声明树
    this.expanding.add(record.name);
    for (const field of record.fields) {
      if (field.name && !field.typeInferred) this.walk(field.type, `${path}.${field.name}`, depth + 1);
    }
    this.expanding.delete(record.name);
  }

  private isLeafType(name: string): boolean {
    return PRIMITIVES.has(name) || this.enums.has(name);
  }

  private leaf(path: string, pii: CorePiiType | null): void {
    this.declared.add(path);
    if (pii) this.marks.set(path, { path, level: pii.sensitivity, category: pii.category, source: 'ir' });
    if (this.declared.size > MAX_DECLARED) this.overflow = true;
  }
}

/**
 * 由 Core IR 推导执行输入的分类：入口 Rule 的每个参数以参数名为前缀；源码未标注类型的参数不产生路径。
 * 函数不存在或超上限时返回 null（调用方按 `none` 处理，fail-closed）。
 */
export function classifyExecutionInput(module: CoreModule, functionName: string): InputClassification | null {
  const func = module.decls.find((d): d is CoreFunc => d.kind === 'Func' && d.name === functionName);
  if (!func) return null;
  const walker = new ClassificationWalker(module);
  for (const param of func.params) {
    if (representableKey(param.name) && !param.typeInferred) walker.walk(param.type, param.name, 0);
  }
  return walker.result();
}

/** 被执行版本的编译输入：与执行端同一份源码、语言、关键词别名与领域词汇。 */
export interface ExecutionInputSource {
  readonly source: string;
  readonly locale: string;
  readonly aliasSet: Record<string, readonly string[]> | null | undefined;
  /** 执行用的领域词汇（DomainVocabulary JSON）；缺省表示不带词汇。 */
  readonly vocabulary?: Record<string, unknown> | null;
}

/** 每个 isolate 最多缓存的分类数；已保存版本的源码不可变，单条只是路径列表。 */
const CACHE_LIMIT = 256;
const cache = new Map<string, InputClassification | null>();

export function clearExecutionInputClassificationCache(): void {
  cache.clear();
}

function scopesOf(vocabulary: Record<string, unknown> | null | undefined): VocabularyScopes | undefined {
  return vocabulary ? buildVocabularyScopes(vocabulary as unknown as DomainVocabulary) : undefined;
}

function compileClassification(input: ExecutionInputSource, functionName: string, scopes: VocabularyScopes | undefined) {
  const base = getLexicon(input.locale);
  const aliases = input.aliasSet && Object.keys(input.aliasSet).length > 0
    ? Object.fromEntries(Object.entries(input.aliasSet).map(([k, v]) => [k, [...v]]))
    : null;
  const lexicon = aliases ? { ...base, aliases: { ...base.aliases, ...aliases } } : base;
  const parsed = parseSource(input.source, lexicon, scopes);
  if (parsed.diagnostics.some((d) => d.severity === 'error')) return null;
  const resolved = resolveAndLowerChecked(parsed.ast, scopes);
  if (resolved.diagnostics.length > 0) return null;
  return classifyExecutionInput(resolved.core, functionName);
}

/**
 * 被执行版本的输入分类（LRU 缓存）。函数名缺失、源码解析失败、词汇非法时返回 null。
 * @param functionName 执行行记录的入口 Rule 规范名（`Execution.functionName`）
 */
export function resolveExecutionInputClassification(
  input: ExecutionInputSource,
  functionName: string | null | undefined,
): InputClassification | null {
  if (!functionName) return null;
  let scopes: VocabularyScopes | undefined;
  try {
    scopes = scopesOf(input.vocabulary);
  } catch {
    return null;
  }
  const key = createHash('sha256')
    .update([getLexicon(input.locale).id, JSON.stringify(input.aliasSet ?? null), scopes ? canonicalScopesJson(scopes) : '', functionName, input.source].join('\0'))
    .digest('hex');
  if (cache.has(key)) {
    const hit = cache.get(key)!;
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  let result: InputClassification | null;
  try {
    result = compileClassification(input, functionName, scopes);
  } catch (err) {
    console.warn('[execution-input] failed to classify execution input', err);
    result = null;
  }
  cache.set(key, result);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return result;
}

/* ---------------------------------------------------------------- 打码 */

const unknownValue = () => ({ [PII_KEY]: { level: 'unknown' } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 标量或标量数组（整体一个叶子）。 */
function scalarShaped(value: unknown): boolean {
  if (isPlainObject(value)) return false;
  return !Array.isArray(value) || value.every((item) => typeof item !== 'object' || item === null);
}

/**
 * 第二层正则：与 aster-api `io.aster.policy.common.PIIRedactor` 同一组模式、同一顺序、同一替换串
 * （SSN → 邮箱 → 电话 → 信用卡 → IP），审批面与日志面对同一字符串得到同一结果。
 */
const REDACTION_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b\d{3}-?\d{2}-?\d{4}\b/g, '***-**-****'],
  [/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g, '***@***.***'],
  [/\(\d{3}\)\s*\d{3}[-.]?\d{4}|\b\d{3}[-.]\d{3}[-.]\d{4}\b|\b\d{10}\b/g, '(***) ***-****'],
  [/\b(?:\d{4}[-\s]?){3}\d{4}(?:\d{3})?\b/g, '****-****-****-****'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '***.***.***.***'],
];

export function redactInputString(value: string): string {
  return REDACTION_RULES.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

/** 只作用于字符串（含标量数组的元素）；空白串与规范 UUID 整串豁免（同 aster-api `isRedactionExempt`）。 */
function plain(value: unknown): unknown {
  if (typeof value === 'string') return value.trim() === '' || UUID.test(value) ? value : redactInputString(value);
  if (Array.isArray(value)) return value.map(plain);
  return value;
}

class MaskWalker {
  private readonly declared: Set<string>;
  private readonly marks: Map<string, PiiMark>;
  /** 声明叶子的所有严格前缀（`a.b.c` → `a`、`a.b`；`x[].y` → `x`、`x[]`）。 */
  private readonly containers = new Set<string>();

  constructor(classification: InputClassification) {
    this.declared = new Set(classification.declared);
    this.marks = new Map(classification.marks.map((m) => [m.path, m]));
    for (const path of classification.declared) {
      for (let i = 0; i < path.length; i++) {
        if (path[i] === '.' || path[i] === '[') this.containers.add(path.slice(0, i));
        if (path[i] === ']') this.containers.add(path.slice(0, i + 1));
      }
    }
  }

  /** depth 为对象 / 数组嵌套层数（输入根为 1）。 */
  node(value: unknown, path: string, depth: number): unknown {
    if (depth > MAX_DEPTH) return unknownValue();
    if (this.declared.has(path)) return this.leaf(value, path);
    if (isPlainObject(value) && this.containers.has(path)) {
      return this.object(value, (k) => `${path}.${k}`, depth + 1);
    }
    if (Array.isArray(value) && this.containers.has(`${path}[]`)) {
      return value.map((item) => (isPlainObject(item) && depth + 1 <= MAX_DEPTH ? this.node(item, `${path}[]`, depth + 1) : unknownValue()));
    }
    return unknownValue();
  }

  /** 输入根：已声明的参数名原样展示。 */
  root(value: Record<string, unknown>): Record<string, unknown> {
    return this.object(value, (k) => k, 2);
  }

  /**
   * 对象：已声明（叶子或容器）的键保留键名并递归；其余键名不展示，合并为一项 {@link UNDECLARED_KEY}。
   * 键名含 `.` / `[` / `]` / 控制字符时拼出的路径有歧义（如键 `"a.b"` 会冒充路径 `a.b`），一律按未声明处理。
   */
  private object(value: Record<string, unknown>, pathOf: (key: string) => string, depth: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    let undeclared = false;
    for (const [k, v] of Object.entries(value)) {
      const path = pathOf(k);
      if (representableKey(k) && (this.declared.has(path) || this.containers.has(path) || this.containers.has(`${path}[]`))) {
        out[k] = this.node(v, path, depth);
      } else {
        undeclared = true;
      }
    }
    if (undeclared) out[UNDECLARED_KEY] = unknownValue();
    return out;
  }

  private leaf(value: unknown, path: string): unknown {
    if (!scalarShaped(value)) return unknownValue();
    const mark = this.marks.get(path);
    if (mark) return { [PII_KEY]: { level: mark.level, ...(mark.category ? { category: mark.category } : {}) } };
    return plain(value);
  }
}

/**
 * 渲染执行输入的打码视图；分类为 null（`none`）时没有任何已声明键，整个输入只剩一项 {@link UNDECLARED_KEY}。
 * 输入根不是对象时整体 unknown。
 * 不提供解除：本函数的输出就是日志面能看到的全部。
 */
export function renderMaskedExecutionInput(input: unknown, classification: InputClassification | null): unknown {
  if (!isPlainObject(input)) return unknownValue();
  return new MaskWalker(classification ?? { declared: [], marks: [] }).root(input);
}
