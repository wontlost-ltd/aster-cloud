/**
 * 解析 / 词法错误（共享码表 E050–E069，ADR 0051 §16 R56）按策略 lexicon 语言渲染（aster-cloud#660）。
 *
 * aster-lang-ts 的解析诊断给出 `code` + 命名参数 `params`，`message` 只是英文渲染结果。这里按码取
 * aster-lang-locales 的 `syntax-diagnostics/<locale-id>.json` 句子模板（随 @aster-cloud/ui-messages 分发，
 * 与服务端 aster-api 共用同一份目录），再逐个渲染参数：
 * - `kw.<英文规范关键词>`：取目标词法的关键词，加单引号（与解析器原文的写法一致）；
 * - `token.<名称>`：取目录里的名词短语；
 * - 带单引号的字面片段：整体是英文标点时换成目标词法写法（zh `'。'`、hi `'।'`），其余原样；
 * - 数字原样。
 * 码没有模板、任一参数缺译文或无码时退回按英文句型翻译（parse-diagnostic-l10n），仍不认识才返回英文。
 * en-US 直接用引擎英文消息。改文案改 locales，不改这里。
 */

import { DE_DE, EN_US, HI_IN, ZH_CN, type Lexicon } from '@aster-cloud/aster-lang-ts/browser';
import zhCatalog from '@aster-cloud/ui-messages/syntax-diagnostics/zh-CN.json';
import deCatalog from '@aster-cloud/ui-messages/syntax-diagnostics/de-DE.json';
import hiCatalog from '@aster-cloud/ui-messages/syntax-diagnostics/hi-IN.json';
import { localizeParseMessage } from './parse-diagnostic-l10n';

type Catalog = Readonly<Record<string, string>>;

/** 引擎给出的解析诊断（ParseError 的子集）。 */
export interface SyntaxDiagnosticLike {
  message: string;
  code?: string;
  params?: Readonly<Record<string, string | number>>;
}

interface Template {
  key: string;
  /** 目录模板占位符 → 引擎参数名（同名时省略）。 */
  rename?: Readonly<Record<string, string>>;
}

/** 码 → 目录模板。E064 的几种固定构造另有整句文案，见 FIXED_CONSTRUCT_KEYS。 */
const TEMPLATES: Readonly<Record<string, Template>> = {
  // unrecognizedCharacter 不带占位符，会丢掉具体字符；改用 unexpected 模板以 {char} 代入（意外的 '§'）
  E050: { key: 'unexpected', rename: { token: 'char' } },
  // 引擎 E052 不带参数，英文仅两句（2 空格倍数 / 反缩进不一致）；目录整句同时覆盖两者并写明 2 空格
  E052: { key: 'indentation' },
  E051: { key: 'unterminatedString' },
  E053: { key: 'literalOutOfRange' },
  E054: { key: 'nestingTooDeep' },
  E055: { key: 'expected' },
  E056: { key: 'expectedAfter' },
  E057: { key: 'expectedIn' },
  E058: { key: 'expectedAfterIn' },
  E059: { key: 'expectedAtEndOfStatement' },
  E060: { key: 'expectedBefore' },
  E061: { key: 'unexpected' },
  E062: { key: 'unexpectedExpecting' },
  E063: { key: 'noViable' },
  E064: { key: 'unexpected', rename: { token: 'construct' } },
  E065: { key: 'misplaced' },
  E066: { key: 'emptyBlock' },
  E067: { key: 'invalidValue' },
  E068: { key: 'callArity' },
  E069: { key: 'unknownName' },
};

const FIXED_CONSTRUCT_KEYS: Readonly<Record<string, string>> = {
  'token.statement': 'unknownStatement',
  'token.topLevelToken': 'unexpectedAtTopLevel',
  'token.expression': 'unexpectedExpression',
};

/** 本模块从目录里取的句子 key（测试据此核对四种语言的目录都齐全）。 */
export const SYNTAX_MESSAGE_KEYS: readonly string[] = [
  ...new Set([...Object.values(TEMPLATES).map((t) => t.key), ...Object.values(FIXED_CONSTRUCT_KEYS)]),
];

/**
 * 解析器报的英文标点 → 目标词法写法，按词法的 punctuation 表逐项对应。
 * 顺序有意义：en 的 listSeparator 与 enumSeparator 同为 `,`，解析器报 `','` 的位置都是列表 / 参数分隔，
 * 故取 listSeparator（zh `，`），不取 enumSeparator（zh `、`）。
 */
const PUNCTUATION_KEYS = ['statementEnd', 'blockStart', 'listSeparator'] as const;

/** 英文规范关键词（小写）→ 语义 token 种类；多个种类同词时取第一个。 */
const KEYWORD_KIND_BY_ENGLISH = new Map<string, string>();
for (const [kind, word] of Object.entries(EN_US.keywords)) {
  const key = String(word).toLowerCase();
  if (!KEYWORD_KIND_BY_ENGLISH.has(key)) KEYWORD_KIND_BY_ENGLISH.set(key, kind);
}

interface Target {
  catalog: Catalog;
  lexicon: Lexicon;
  punctuation: ReadonlyMap<string, string>;
}

function target(catalog: Catalog, lexicon: Lexicon): Target {
  const punctuation = new Map<string, string>();
  for (const key of PUNCTUATION_KEYS) {
    const from = EN_US.punctuation[key];
    if (!punctuation.has(from)) punctuation.set(from, lexicon.punctuation[key]);
  }
  return { catalog, lexicon, punctuation };
}

const TARGETS: ReadonlyMap<string, Target> = new Map([
  ['zh-CN', target(zhCatalog, ZH_CN)],
  ['de-DE', target(deCatalog, DE_DE)],
  ['hi-IN', target(hiCatalog, HI_IN)],
]);

/** 渲染一个参数值；缺译文返回 null。 */
function renderParam(value: string | number, t: Target): string | null {
  if (typeof value === 'number') return String(value);
  if (value.startsWith('kw.')) {
    const kind = KEYWORD_KIND_BY_ENGLISH.get(value.slice(3));
    const word = kind ? (t.lexicon.keywords as Readonly<Record<string, string>>)[kind] : undefined;
    return word ? `'${word}'` : null;
  }
  if (value.startsWith('token.')) return t.catalog[value] ?? null;
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    const mapped = t.punctuation.get(value.slice(1, -1));
    return mapped ? `'${mapped}'` : value;
  }
  return value;
}

/** 按名称一次性填充 `{name}` 占位符；填进去的文本不会再被替换。缺任一值返回 null。 */
function fill(template: string, values: (name: string) => string | null): string | null {
  let missing = false;
  const out = template.replace(/\{(\w+)\}/g, (_whole, name: string) => {
    const v = values(name);
    if (v === null) missing = true;
    return v ?? '';
  });
  return missing ? null : out;
}

/** 汉字与引号片段相邻处补空格（`应为 '.'`、`'那么' 之后`），与引擎中文诊断的排版一致；引号内不动。 */
function spaceQuotes(s: string): string {
  const cjk = /\p{Script=Han}/u;
  return s.replace(/'[^']*'/g, (fragment, offset: number) => {
    const before = s[offset - 1];
    const after = s[offset + fragment.length];
    return `${before && cjk.test(before) ? ' ' : ''}${fragment}${after && cjk.test(after) ? ' ' : ''}`;
  });
}

function render(d: SyntaxDiagnosticLike, t: Target): string | null {
  const template = d.code ? TEMPLATES[d.code] : undefined;
  if (!template) return null;
  const params = d.params ?? {};
  const fixedKey = d.code === 'E064' ? FIXED_CONSTRUCT_KEYS[String(params.construct)] : undefined;
  if (fixedKey) return t.catalog[fixedKey] ?? null;
  const sentence = t.catalog[template.key];
  if (!sentence) return null;
  const text = fill(sentence, (name) => {
    const value = params[template.rename?.[name] ?? name];
    return value === undefined ? null : renderParam(value, t);
  });
  if (text === null) return null;
  return t.catalog['style.spaceQuotesAfterHan'] === 'true' ? spaceQuotes(text) : text;
}

/** 按策略 lexicon 语言渲染解析诊断；按码渲染不了时退回英文句型翻译；en-US 与未收录语言返回英文。 */
export function localizeSyntaxDiagnostic(d: SyntaxDiagnosticLike, locale: string | undefined): string {
  const t = locale ? TARGETS.get(locale) : undefined;
  return (t && render(d, t)) ?? localizeParseMessage(d.message, locale);
}
