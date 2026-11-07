/**
 * 无码 / 按码渲染不了的解析类消息按英文句型本地化（兜底）。
 *
 * 解析错误优先按 code + params 渲染（syntax-diagnostic-message）；只有无码、或按码渲染缺名词 / 缺参数的
 * 解析错误仍走这里，保证 zh/de/hi 看到的英文不多于按句型翻译时。降级诊断（E600–E606）由引擎本地化，不经本模块。
 *
 * 按解析器的固定句型翻译骨架与常见名词。引号内的关键词原样保留；
 * 引号内的标点按目标词法的实际写法改写（zh：`'。'`、`'：'`、`'，'`；hi：`'।'`）。
 * 句型或名词任一不认识时返回原文，避免半中半英的拼接。
 *
 * 文案来自 aster-lang-locales 的 `syntax-diagnostics/<locale-id>.json`（随 @aster-cloud/ui-messages 分发）。
 * en-US 目录里的句子与名词就是解析器的英文原文，这里按 en 值反查 key。
 */

import { DE_DE, EN_US, HI_IN, ZH_CN, type Lexicon } from '@aster-cloud/aster-lang-ts/browser';
import enCatalog from '@aster-cloud/ui-messages/syntax-diagnostics/en-US.json';
import zhCatalog from '@aster-cloud/ui-messages/syntax-diagnostics/zh-CN.json';
import deCatalog from '@aster-cloud/ui-messages/syntax-diagnostics/de-DE.json';
import hiCatalog from '@aster-cloud/ui-messages/syntax-diagnostics/hi-IN.json';

type Catalog = Readonly<Record<string, string>>;

/** 解析器消息里出现的名词短语对应的目录 key（英文原文取 en-US 目录的值）。 */
const NOUN_KEYS = [
  'token.identifier',
  'token.type',
  'token.typeName',
  'token.returnType',
  'token.construction',
  'token.dot',
  'token.newline',
  'token.indent',
  'token.dedent',
  'token.expression',
  'token.statement',
  'token.dataDefinition',
  'token.enumDefinition',
  'token.ifExpression',
  'token.inlineIf',
  'token.functionBody',
  'token.explicitBlock',
  'token.annotationArgumentValue',
  'token.integer',
  'token.atLeastOneStatement',
  'token.workflowHeader',
  'token.workflowBody',
  'token.cases',
  'token.retryPolicy',
] as const;

/** 整句固定的消息 */
const FIXED_KEYS = ['unknownStatement', 'unexpectedAtTopLevel', 'unexpectedExpression'] as const;

interface Rule {
  re: RegExp;
  key: string;
  /** 依次对应正则捕获组的占位符名 */
  slots: readonly string[];
}

// 顺序有意义：更具体的句型在前
const RULES: readonly Rule[] = [
  { re: /^Expected (.+) at end of statement$/, key: 'expectedAtEndOfStatement', slots: ['token'] },
  { re: /^Expected (.+) after (.+) in (.+)$/, key: 'expectedAfterIn', slots: ['token', 'after', 'context'] },
  { re: /^Expected (.+) after (.+)$/, key: 'expectedAfter', slots: ['token', 'after'] },
  { re: /^Expected (.+) in (.+)$/, key: 'expectedIn', slots: ['token', 'context'] },
  { re: /^Expected (.+)$/, key: 'expected', slots: ['token'] },
  { re: /^Unexpected ('.*')$/, key: 'unexpected', slots: ['token'] },
];

/** 本模块从目录里取的全部 key（测试据此核对四种语言的目录都齐全）。 */
export const PARSE_MESSAGE_KEYS: readonly string[] = [
  ...RULES.map((rule) => rule.key),
  ...FIXED_KEYS,
  ...NOUN_KEYS,
  'or',
  'style.spaceQuotesAfterHan',
];

/**
 * 解析器消息里的英文标点 → 目标词法的写法，按词法的 punctuation 表逐项对应。
 * 顺序有意义：en 的 listSeparator 与 enumSeparator 同为 `,`，解析器报 `','` 的位置都是列表 / 参数分隔，
 * 故取 listSeparator（zh `，`），不取 enumSeparator（zh `、`）。
 */
const PUNCTUATION_KEYS = ['statementEnd', 'blockStart', 'listSeparator'] as const;

function punctuationMap(target: Lexicon): Map<string, string> {
  const map = new Map<string, string>();
  for (const key of PUNCTUATION_KEYS) {
    const from = EN_US.punctuation[key];
    if (!map.has(from)) map.set(from, target.punctuation[key]);
  }
  return map;
}

interface Target {
  catalog: Catalog;
  punctuation: Map<string, string>;
}

const TARGETS: ReadonlyMap<string, Target> = new Map([
  ['zh-CN', { catalog: zhCatalog, punctuation: punctuationMap(ZH_CN) }],
  ['de-DE', { catalog: deCatalog, punctuation: punctuationMap(DE_DE) }],
  ['hi-IN', { catalog: hiCatalog, punctuation: punctuationMap(HI_IN) }],
]);

const en: Catalog = enCatalog;

/** 英文原文 → key：名词短语与整句消息都按 en-US 目录的值反查。 */
const NOUN_KEY_BY_ENGLISH = new Map<string, string>(NOUN_KEYS.map((key) => [en[key]!, key]));
const FIXED_KEY_BY_ENGLISH = new Map<string, string>(FIXED_KEYS.map((key) => [en[key]!, key]));

const QUOTED_LIST = /^'[^']*'(?: or '[^']*')*$/;

/** 引号片段整体是一个英文标点时换成目标词法的写法；关键词与其余符号原样保留。 */
function quoted(fragment: string, target: Target): string {
  const mapped = target.punctuation.get(fragment.slice(1, -1));
  return mapped ? `'${mapped}'` : fragment;
}

/** 翻译一个槽位：引号列表（'a' or 'b'）只翻连接词与标点，名词短语查表；不认识返回 null。 */
function slot(text: string, target: Target): string | null {
  const t = text.trim();
  if (QUOTED_LIST.test(t)) {
    return t.split(' or ').map((q) => quoted(q, target)).join(target.catalog.or);
  }
  const key = NOUN_KEY_BY_ENGLISH.get(t);
  return key ? target.catalog[key] ?? null : null;
}

/** 按名称一次性填充 `{name}` 占位符；填进去的文本不会再被替换。 */
function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

/** 汉字与引号片段相邻处补空格（`应为 '.'`、`'那么' 之后`），与引擎中文诊断的排版一致；引号内不动。 */
function spaceQuotes(s: string): string {
  // 只对汉字补空格：全角标点（，。：）与引号相邻时不加空格
  const cjk = /\p{Script=Han}/u;
  return s.replace(/'[^']*'/g, (fragment, offset: number) => {
    const before = s[offset - 1];
    const after = s[offset + fragment.length];
    return `${before && cjk.test(before) ? ' ' : ''}${fragment}${after && cjk.test(after) ? ' ' : ''}`;
  });
}

function styled(text: string, target: Target): string {
  return target.catalog['style.spaceQuotesAfterHan'] === 'true' ? spaceQuotes(text) : text;
}

/** 按策略 lexicon 语言翻译解析错误消息；en-US、未收录语言、不认识的句型均返回原文。 */
export function localizeParseMessage(message: string, locale: string | undefined): string {
  const target = locale ? TARGETS.get(locale) : undefined;
  if (!target) return message;
  const fixedKey = FIXED_KEY_BY_ENGLISH.get(message);
  const fixed = fixedKey ? target.catalog[fixedKey] : undefined;
  if (fixed) return fixed;
  for (const rule of RULES) {
    const m = rule.re.exec(message);
    const template = target.catalog[rule.key];
    if (!m || !template) continue;
    const slots = m.slice(1).map((s) => slot(s, target));
    // 槽位不认识时试下一条句型（如 `after 'y in z'` 先被三槽句型误切，两槽句型可以译）
    if (slots.some((s) => s === null)) continue;
    const values = Object.fromEntries(rule.slots.map((name, i) => [name, slots[i]!]));
    return styled(fill(template, values), target);
  }
  return message;
}
