/**
 * 模型标签页的名字校验（ADR 0058 §8.3），分两层：
 *
 * 1. 词法预检（{@link isValidTypeName} / {@link isValidFieldName}）：用 aster-lang-ts 自己的规范化器
 *    与词法器判定候选名恰好是一个标识符 token。只为给出「须是单个词」这一更具体的提示。
 * 2. 往返校验（{@link structNameRoundTrips} / {@link typeAliasNameRoundTrips} / {@link fieldNameRoundTrips}）：
 *    关键词是否被识别、冠词是否被删除都取决于名字在声明中的上下文（如德语 `der`、中文 `定义`），
 *    孤立判断看不出来。因此用表单实际使用的 source builders 生成声明，放进最小模块，以大纲同款
 *    compile + lexicon（编辑器传入的 lexicon 已含用户关键词别名）解析，要求 {@link buildModelOutline}
 *    读回的名字与输入完全一致。能否编译只由编译器判断。
 *
 * 每个名字按它在表单产出中的角色单独往返：表单里名字之间只隔关键词，冠词删除只看前后相邻的词，
 * 所以单名字的上下文与整条声明里的上下文一致，出错时也能指明是哪个名字。类型名除了声明位置，
 * 还须能在字段类型与别名目标位置被引用（德语 `der` 作结构体名能声明，作类型引用时会被当冠词删掉）。
 * 字段类型与别名目标一律用本地化 Text：它们来自下拉，不是作者输入。
 *
 * 结构体 / 类型别名名：词法预检接受 IDENT 与 TYPE_IDENT，但小写字母起首的名字（`person`）作类型引用时被
 * aster-lang-ts ≥ 3.6.0 报 E055，往返校验会拒绝；界面据此提示「类型名须以大写字母开头」，而非「保留词」。
 * 字段名：解析器只接受 IDENT（拉丁语言里大写起首会被词法器归为 TYPE_IDENT）。
 *
 * 名字转义（ADR 0058 修订 3 E1，ADR 0064）：往返选项 `escaped` 为真时，声明与引用都写成 `` `name` ``，
 * 仍要求读回原名（IR 名字是转义内容本身，N4）。转义只去掉关键词、别名、触发词、冠词与规范化改写，不放宽字符规则：
 * {@link isValidEscapedTypeName} / {@link isValidEscapedFieldName} 按转义写法做词法预检，token 类型照旧按首字符决定（N1）。
 */
import { canonicalize, foldKey, lex, TokenKind, type DomainVocabulary, type Lexicon } from '@aster-cloud/aster-lang-ts/browser';
import { SemanticTokenKind } from '@/lib/aster-lexicon';
import { buildModelOutline, type ModelOutline } from './outline';
import { buildStructSource, buildTypeAliasSource, builtinTypeNames } from './source-builders';

type IdentifierKind = typeof TokenKind.IDENT | typeof TokenKind.TYPE_IDENT;

function isSingleToken(lexicon: Lexicon, raw: string, accepted: readonly IdentifierKind[]): boolean {
  const name = raw.trim();
  if (name.length === 0) return false;
  try {
    const tokens = lex(canonicalize(name, lexicon), lexicon);
    // [标识符, EOF]，且原文未被规范化改写
    const [head, end, ...rest] = tokens;
    return (
      rest.length === 0 &&
      end?.kind === TokenKind.EOF &&
      head !== undefined &&
      accepted.includes(head.kind as IdentifierKind) &&
      head.value === name
    );
  } catch {
    return false;
  }
}

export const isValidTypeName = (lexicon: Lexicon, name: string): boolean =>
  isSingleToken(lexicon, name, [TokenKind.IDENT, TokenKind.TYPE_IDENT]);

export const isValidFieldName = (lexicon: Lexicon, name: string): boolean =>
  isSingleToken(lexicon, name, [TokenKind.IDENT]);

/** 名字的转义写法 `` `name` ``（ADR 0064 §3.1；首尾空白不进入转义）。 */
export const escapeName = (name: string): string => `\`${name.trim()}\``;

/** 转义写法恰好是一个名字 token：内容合法（N1a）且读回原名，不论这个词是否关键词。 */
function isSingleEscapedToken(lexicon: Lexicon, raw: string, accepted: readonly IdentifierKind[]): boolean {
  const name = raw.trim();
  if (name.length === 0 || name.includes('`')) return false;
  try {
    const [head, end, ...rest] = lex(canonicalize(escapeName(name), lexicon), lexicon);
    return (
      rest.length === 0 &&
      end?.kind === TokenKind.EOF &&
      head !== undefined &&
      accepted.includes(head.kind as IdentifierKind) &&
      head.value === name
    );
  } catch {
    return false;
  }
}

export const isValidEscapedTypeName = (lexicon: Lexicon, name: string): boolean =>
  isSingleEscapedToken(lexicon, name, [TokenKind.IDENT, TokenKind.TYPE_IDENT]);

export const isValidEscapedFieldName = (lexicon: Lexicon, name: string): boolean =>
  isSingleEscapedToken(lexicon, name, [TokenKind.IDENT]);

/** 名字在源码里的写法：原样或转义。 */
const spell = (name: string, escaped: boolean | undefined): string => (escaped ? escapeName(name) : name);

/**
 * 往返选项。`escaped`：名字写成转义；`vocabulary`：版本的有效词汇，只用于让字面量触发词在规范化时展开
 * （触发词作名字时读不回原名）。都缺省时与引入转义之前逐字节相同。
 */
export interface RoundTripOptions {
  readonly escaped?: boolean;
  readonly vocabulary?: DomainVocabulary;
}

/** 把若干声明放进最小模块（模块名 `m` 在四种语言下均为合法标识符），解析失败返回 null。 */
function outlineOf(lexicon: Lexicon, declarations: readonly string[], vocabulary?: DomainVocabulary): ModelOutline | null {
  const header = `${lexicon.keywords[SemanticTokenKind.MODULE_DECL]} m${lexicon.punctuation.statementEnd}`;
  return buildModelOutline([header, ...declarations].join('\n\n') + '\n', lexicon, vocabulary);
}

/** 占位名（四种语言下均能按原名读回）中第一个与候选名折叠后不同的，避免占位与候选重名。 */
const placeholder = (candidate: string, options: readonly string[]): string =>
  options.find((o) => foldKey(o) !== foldKey(candidate.trim())) ?? options[0];

const TYPE_PLACEHOLDERS = ['T', 'U', 'V', 'W'] as const;
const FIELD_PLACEHOLDERS = ['x', 'y', 'z'] as const;

const textType = (lexicon: Lexicon) => lexicon.keywords[SemanticTokenKind.TEXT];

/** 引用 `name` 的两条声明：`Define U with x as <name> and y as Text.`、`Type V as <name>.`；`escaped` 时引用写成转义。 */
function referencesTo(
  lexicon: Lexicon,
  name: string,
  escaped: boolean | undefined,
): { holder: string; alias: string; sources: string[] } {
  const holder = placeholder(name, TYPE_PLACEHOLDERS);
  const alias = placeholder(name, TYPE_PLACEHOLDERS.filter((p) => p !== holder));
  const written = spell(name, escaped);
  const sources = [
    buildStructSource(lexicon, {
      name: holder,
      fields: [
        { name: 'x', type: written },
        { name: 'y', type: textType(lexicon) },
      ],
    }),
    buildTypeAliasSource(lexicon, { name: alias, target: written }),
  ];
  return { holder, alias, sources };
}

/** 大纲里的引用原样读回 `written`（大纲按源码原文截取类型，转义引用读回的是 `` `name` ``）。 */
function referencesReadBack(outline: ModelOutline, refs: { holder: string; alias: string }, written: string): boolean {
  const holder = outline.structs.find((s) => s.name === refs.holder);
  const alias = outline.typeAliases.find((a) => a.name === refs.alias);
  return holder?.fields[0]?.type === written && alias?.target === written;
}

/** 结构体名往返：`Define <name> with x as Text.` 读回同名结构体，且能作类型被引用；`escaped` 时声明与引用都写成转义。 */
export function structNameRoundTrips(lexicon: Lexicon, raw: string, opts: RoundTripOptions = {}): boolean {
  const { escaped, vocabulary } = opts;
  const name = raw.trim();
  const refs = referencesTo(lexicon, name, escaped);
  const declaration = buildStructSource(lexicon, {
    name: spell(name, escaped),
    fields: [{ name: 'x', type: textType(lexicon) }],
  });
  const outline = outlineOf(lexicon, [declaration, ...refs.sources], vocabulary);
  return (
    outline !== null &&
    outline.structs.length === 2 &&
    outline.typeAliases.length === 1 &&
    outline.structs[0].name === name &&
    referencesReadBack(outline, refs, spell(name, escaped))
  );
}

/** 类型别名名往返：`Type <name> as Text.` 读回同名类型别名，且能作类型被引用；`escaped` 时声明与引用都写成转义。 */
export function typeAliasNameRoundTrips(lexicon: Lexicon, raw: string, opts: RoundTripOptions = {}): boolean {
  const { escaped, vocabulary } = opts;
  const name = raw.trim();
  const refs = referencesTo(lexicon, name, escaped);
  const declaration = buildTypeAliasSource(lexicon, { name: spell(name, escaped), target: textType(lexicon) });
  const outline = outlineOf(lexicon, [declaration, ...refs.sources], vocabulary);
  return (
    outline !== null &&
    outline.structs.length === 1 &&
    outline.typeAliases.length === 2 &&
    outline.typeAliases[0].name === name &&
    referencesReadBack(outline, refs, spell(name, escaped))
  );
}

/**
 * 字段名往返：作首个字段（`Define T with <name> as Text.`）与后续字段（`… with x as Text and <name> as Text.`，
 * 即「添加字段」插入的 `and <子句>` 上下文）都读回原名；`escaped` 时字段写成转义。
 */
export function fieldNameRoundTrips(lexicon: Lexicon, raw: string, opts: RoundTripOptions = {}): boolean {
  const { escaped, vocabulary } = opts;
  const name = raw.trim();
  const other = placeholder(name, FIELD_PLACEHOLDERS);
  const field = (n: string) => ({ name: n, type: textType(lexicon) });
  const written = spell(name, escaped);
  const outline = outlineOf(lexicon, [
    buildStructSource(lexicon, { name: 'T', fields: [field(written)] }),
    buildStructSource(lexicon, { name: 'U', fields: [field(other), field(written)] }),
  ], vocabulary);
  if (outline === null || outline.structs.length !== 2) return false;
  const [first, second] = outline.structs;
  return (
    first.fields.length === 1 &&
    first.fields[0].name === name &&
    second.fields.length === 2 &&
    second.fields[1].name === name
  );
}

/** 模型表单里名字的角色：结构体名、类型别名名与字段名的声明上下文各不相同。 */
export type NameRole = 'struct' | 'alias' | 'field';

/**
 * 一个名字能否写进表单产出、怎么写：
 * - `plain`：原样写；`escaped`：写成 `written`（`` `name` ``），界面提示「已自动转义」；
 * - `invalid`：不是单个词（词法预检）；`reserved`：单个词，但放进声明后读不回原名且转义也救不了；
 * - `lowercaseType`：类型名小写起首，改成大写即可（作类型引用时编译器报 E055，转义不改变这条规则）。
 */
export type NameVerdict =
  | { kind: 'plain'; written: string }
  | { kind: 'escaped'; written: string }
  | { kind: 'invalid' }
  | { kind: 'reserved' }
  | { kind: 'lowercaseType' };

export interface NameVerdictOptions {
  /** 平台开关 `authoring.name_escape.enabled`（ADR 0058 修订 3）。关闭时判定与引入转义之前逐字节相同。 */
  readonly nameEscape: boolean;
  /** 版本的有效词汇（开关打开时参与往返，字面量触发词作名字时据此识别）。 */
  readonly vocabulary?: DomainVocabulary;
}

const ROUND_TRIP: Record<NameRole, (lexicon: Lexicon, raw: string, opts?: RoundTripOptions) => boolean> = {
  struct: structNameRoundTrips,
  alias: typeAliasNameRoundTrips,
  field: fieldNameRoundTrips,
};

const isPlainValid = (lexicon: Lexicon, role: NameRole, name: string) =>
  role === 'field' ? isValidFieldName(lexicon, name) : isValidTypeName(lexicon, name);

const isEscapedValid = (lexicon: Lexicon, role: NameRole, name: string) =>
  role === 'field' ? isValidEscapedFieldName(lexicon, name) : isValidEscapedTypeName(lexicon, name);

/** 首字母改大写；非小写起首返回 null（与 aster-lang-ts isBareLowercaseTypeAt 同一判据：Unicode Ll）。 */
function capitalized(name: string): string | null {
  const trimmed = name.trim();
  return /^\p{Ll}/u.test(trimmed) ? trimmed.replace(/^./u, (c) => c.toUpperCase()) : null;
}

/**
 * 判定非空名字的写法（ADR 0058 修订 3 E1）。原样能读回就原样写；类型名只差大小写时提示大写；
 * 否则在开关打开时试转义写法——原样写因为关键词、别名、字面量触发词、冠词或规范化改写而读不回原名，
 * 转义后能读回，就生成 `` `name` ``。其他原因（非法字符、空白等）照旧拒绝。
 */
export function nameVerdict(lexicon: Lexicon, role: NameRole, raw: string, opts: NameVerdictOptions): NameVerdict {
  const name = raw.trim();
  const roundTrips = ROUND_TRIP[role];
  const vocabulary = opts.nameEscape ? opts.vocabulary : undefined;
  const plainValid = isPlainValid(lexicon, role, name);
  if (plainValid && roundTrips(lexicon, name, { vocabulary })) return { kind: 'plain', written: name };
  if (plainValid && role !== 'field') {
    // 仅当改成大写起首即可通过时才提示大小写；小写的关键词 / 冠词（`with`、`der`）大写后仍被拒，照旧报保留词。
    const upper = capitalized(name);
    if (upper !== null && roundTrips(lexicon, upper, { vocabulary })) return { kind: 'lowercaseType' };
  }
  if (opts.nameEscape && isEscapedValid(lexicon, role, name) && roundTrips(lexicon, name, { escaped: true, vocabulary })) {
    return { kind: 'escaped', written: escapeName(name) };
  }
  return plainValid ? { kind: 'reserved' } : { kind: 'invalid' };
}

/**
 * 类型下拉里已声明的类型名（结构体、枚举、类型别名，大纲读回的是 IR 名字、不含反引号）作字段类型或别名目标时的写法：
 * 开关打开且原样引用读不回、转义引用能读回时写成转义，其余原样（内置类型与开关关闭时恒原样：
 * 本地化内置类型名本身就是关键词，转义会把它变成同名的用户类型）。
 */
export function typeReferenceSpelling(lexicon: Lexicon, name: string, opts: NameVerdictOptions): string {
  if (!opts.nameEscape || builtinTypeNames(lexicon).includes(name)) return name;
  const verdict = nameVerdict(lexicon, 'struct', name, opts);
  return verdict.kind === 'escaped' ? verdict.written : name;
}
