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
 */
import { canonicalize, foldKey, lex, TokenKind, type Lexicon } from '@aster-cloud/aster-lang-ts/browser';
import { SemanticTokenKind } from '@/lib/aster-lexicon';
import { buildModelOutline, type ModelOutline } from './outline';
import { buildStructSource, buildTypeAliasSource } from './source-builders';

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

/** 把若干声明放进最小模块（模块名 `m` 在四种语言下均为合法标识符），解析失败返回 null。 */
function outlineOf(lexicon: Lexicon, declarations: readonly string[]): ModelOutline | null {
  const header = `${lexicon.keywords[SemanticTokenKind.MODULE_DECL]} m${lexicon.punctuation.statementEnd}`;
  return buildModelOutline([header, ...declarations].join('\n\n') + '\n', lexicon);
}

/** 占位名（四种语言下均能按原名读回）中第一个与候选名折叠后不同的，避免占位与候选重名。 */
const placeholder = (candidate: string, options: readonly string[]): string =>
  options.find((o) => foldKey(o) !== foldKey(candidate.trim())) ?? options[0];

const TYPE_PLACEHOLDERS = ['T', 'U', 'V', 'W'] as const;
const FIELD_PLACEHOLDERS = ['x', 'y', 'z'] as const;

const textType = (lexicon: Lexicon) => lexicon.keywords[SemanticTokenKind.TEXT];

/** 引用 `name` 的两条声明：`Define U with x as <name> and y as Text.`、`Type V as <name>.` */
function referencesTo(lexicon: Lexicon, name: string): { holder: string; alias: string; sources: string[] } {
  const holder = placeholder(name, TYPE_PLACEHOLDERS);
  const alias = placeholder(name, TYPE_PLACEHOLDERS.filter((p) => p !== holder));
  const sources = [
    buildStructSource(lexicon, {
      name: holder,
      fields: [
        { name: 'x', type: name },
        { name: 'y', type: textType(lexicon) },
      ],
    }),
    buildTypeAliasSource(lexicon, { name: alias, target: name }),
  ];
  return { holder, alias, sources };
}

/** 大纲里的引用原样读回 `name`。 */
function referencesReadBack(outline: ModelOutline, refs: { holder: string; alias: string }, name: string): boolean {
  const holder = outline.structs.find((s) => s.name === refs.holder);
  const alias = outline.typeAliases.find((a) => a.name === refs.alias);
  return holder?.fields[0]?.type === name && alias?.target === name;
}

/** 结构体名往返：`Define <name> with x as Text.` 读回同名结构体，且能作类型被引用。 */
export function structNameRoundTrips(lexicon: Lexicon, raw: string): boolean {
  const name = raw.trim();
  const refs = referencesTo(lexicon, name);
  const declaration = buildStructSource(lexicon, { name, fields: [{ name: 'x', type: textType(lexicon) }] });
  const outline = outlineOf(lexicon, [declaration, ...refs.sources]);
  return (
    outline !== null &&
    outline.structs.length === 2 &&
    outline.typeAliases.length === 1 &&
    outline.structs[0].name === name &&
    referencesReadBack(outline, refs, name)
  );
}

/** 类型别名名往返：`Type <name> as Text.` 读回同名类型别名，且能作类型被引用。 */
export function typeAliasNameRoundTrips(lexicon: Lexicon, raw: string): boolean {
  const name = raw.trim();
  const refs = referencesTo(lexicon, name);
  const declaration = buildTypeAliasSource(lexicon, { name, target: textType(lexicon) });
  const outline = outlineOf(lexicon, [declaration, ...refs.sources]);
  return (
    outline !== null &&
    outline.structs.length === 1 &&
    outline.typeAliases.length === 2 &&
    outline.typeAliases[0].name === name &&
    referencesReadBack(outline, refs, name)
  );
}

/**
 * 字段名往返：作首个字段（`Define T with <name> as Text.`）与后续字段（`… with x as Text and <name> as Text.`，
 * 即「添加字段」插入的 `and <子句>` 上下文）都读回原名。
 */
export function fieldNameRoundTrips(lexicon: Lexicon, raw: string): boolean {
  const name = raw.trim();
  const other = placeholder(name, FIELD_PLACEHOLDERS);
  const field = (n: string) => ({ name: n, type: textType(lexicon) });
  const outline = outlineOf(lexicon, [
    buildStructSource(lexicon, { name: 'T', fields: [field(name)] }),
    buildStructSource(lexicon, { name: 'U', fields: [field(other), field(name)] }),
  ]);
  if (outline === null || outline.structs.length !== 2) return false;
  const [first, second] = outline.structs;
  return (
    first.fields.length === 1 &&
    first.fields[0].name === name &&
    second.fields.length === 2 &&
    second.fields[1].name === name
  );
}
