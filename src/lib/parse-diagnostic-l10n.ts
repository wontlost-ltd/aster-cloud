/**
 * 解析错误（编辑器里的 E000）按策略 lexicon 语言本地化。
 *
 * 引擎的语义诊断（E1xx / E8xx …）已按 lexicon 的 diagnostic overlay 本地化，诊断跟随策略的 CNL 语言
 * 是设计；但 aster-lang-ts 的解析错误没有错误码、也不走 overlay：只有关键词槽位用作者语言
 * （如 `Expected '返回' after '那么'`），句子骨架恒为英文。
 *
 * 这里按解析器的固定句型翻译骨架与常见名词。引号内的关键词解析器已按作者语言给出，原样保留；
 * 引号内的标点解析器恒报英文写法（`'.'`），按目标词法的实际写法改写（zh：`'。'`、`'：'`、`'，'`）。
 * 句型或名词任一不认识时返回原文，避免半中半英的拼接。
 *
 * ★依赖：这是过渡层。aster-lang-ts 给解析错误补上错误码与 diagnostic overlay 译文后，编辑器应改走引擎
 *   的 localizeDiagnostics，并删除本模块（服务端 aster-api 的解析错误同样需要引擎侧译文）。
 */

import { DE_DE, EN_US, ZH_CN, type Lexicon } from '@aster-cloud/aster-lang-ts/browser';

type Lang = 'zh-CN' | 'de-DE';

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

const PUNCTUATION: Record<Lang, Map<string, string>> = {
  'zh-CN': punctuationMap(ZH_CN),
  'de-DE': punctuationMap(DE_DE),
};

/** 解析器消息里出现的名词短语 → [中文, 德文] */
const NOUNS: Record<string, [string, string]> = {
  identifier: ['标识符', 'Bezeichner'],
  type: ['类型', 'Typ'],
  'type name': ['类型名', 'Typname'],
  'return type': ['返回类型', 'Rückgabetyp'],
  construction: ['构造', 'Konstruktion'],
  dot: ['点', 'Punkt'],
  newline: ['换行', 'Zeilenumbruch'],
  indent: ['缩进', 'Einrückung'],
  dedent: ['缩进结束', 'Ausrückung'],
  expression: ['表达式', 'Ausdruck'],
  statement: ['语句', 'Anweisung'],
  'data definition': ['数据定义', 'Datendefinition'],
  'enum definition': ['枚举定义', 'Enum-Definition'],
  'if-expression': ['条件表达式', 'If-Ausdruck'],
  'inline if': ['行内条件', 'Inline-If'],
  'function body': ['函数体', 'Funktionsrumpf'],
  'explicit block': ['显式块', 'expliziter Block'],
  'annotation argument value': ['注解参数值', 'Annotationsargument'],
  integer: ['整数', 'Ganzzahl'],
  'at least one statement': ['至少一条语句', 'mindestens eine Anweisung'],
  'workflow header': ['工作流头', 'Workflow-Kopf'],
  'workflow body': ['工作流体', 'Workflow-Rumpf'],
  cases: ['分支', 'Fälle'],
  'retry policy': ['重试策略', 'Wiederholungsrichtlinie'],
};

/** 整句固定的消息 */
const FIXED: Record<string, [string, string]> = {
  'Unknown statement': ['无法识别的语句', 'Unbekannte Anweisung'],
  'Unexpected token at top level': ['顶层出现意外的记号', 'Unerwartetes Token auf oberster Ebene'],
  'Unexpected expression': ['意外的表达式', 'Unerwarteter Ausdruck'],
  'Expected type': ['此处应为类型', 'Typ erwartet'],
};

const QUOTED_LIST = /^'[^']*'(?: or '[^']*')*$/;

/** 引号片段整体是一个英文标点时换成目标词法的写法；关键词与其余符号原样保留。 */
function quoted(fragment: string, lang: Lang): string {
  const inner = fragment.slice(1, -1);
  const mapped = PUNCTUATION[lang].get(inner);
  return mapped ? `'${mapped}'` : fragment;
}

/** 翻译一个槽位：引号列表（'a' or 'b'）只翻连接词与标点，名词短语查表；不认识返回 null。 */
function slot(text: string, lang: Lang): string | null {
  const t = text.trim();
  if (QUOTED_LIST.test(t)) {
    return t.split(' or ').map((q) => quoted(q, lang)).join(lang === 'zh-CN' ? '或' : ' oder ');
  }
  const noun = NOUNS[t];
  return noun ? noun[lang === 'zh-CN' ? 0 : 1] : null;
}

/** 中文与引号片段相邻处补空格（`应为 '.'`、`'那么' 之后`），与引擎中文诊断的排版一致；引号内不动。 */
function spaceQuotes(s: string): string {
  // 只对汉字补空格：全角标点（，。：）与引号相邻时不加空格
  const cjk = /\p{Script=Han}/u;
  return s.replace(/'[^']*'/g, (quoted, offset: number) => {
    const before = s[offset - 1];
    const after = s[offset + quoted.length];
    return `${before && cjk.test(before) ? ' ' : ''}${quoted}${after && cjk.test(after) ? ' ' : ''}`;
  });
}

interface Rule {
  re: RegExp;
  zh: (s: string[]) => string;
  de: (s: string[]) => string;
}

// 顺序有意义：更具体的句型在前
const RULES: Rule[] = [
  { re: /^Expected (.+) at end of statement$/, zh: ([a]) => `语句末尾应为${a}`, de: ([a]) => `Am Ende der Anweisung wird ${a} erwartet` },
  { re: /^Expected (.+) after (.+) in (.+)$/, zh: ([a, b, c]) => `${c}中，${b}之后应为${a}`, de: ([a, b, c]) => `In ${c} wird nach ${b} ${a} erwartet` },
  { re: /^Expected (.+) after (.+)$/, zh: ([a, b]) => `${b}之后应为${a}`, de: ([a, b]) => `Nach ${b} wird ${a} erwartet` },
  { re: /^Expected (.+) in (.+)$/, zh: ([a, b]) => `${b}中应为${a}`, de: ([a, b]) => `In ${b} wird ${a} erwartet` },
  { re: /^Expected (.+)$/, zh: ([a]) => `此处应为${a}`, de: ([a]) => `${a} erwartet` },
  { re: /^Unexpected ('.*')$/, zh: ([a]) => `意外的${a}`, de: ([a]) => `Unerwartet: ${a}` },
];

/** 按策略 lexicon 语言翻译解析错误消息；en-US、未收录语言、不认识的句型均返回原文。 */
export function localizeParseMessage(message: string, locale: string | undefined): string {
  if (locale !== 'zh-CN' && locale !== 'de-DE') return message;
  const lang: Lang = locale;
  const fixed = FIXED[message];
  if (fixed) return fixed[lang === 'zh-CN' ? 0 : 1];
  for (const rule of RULES) {
    const m = rule.re.exec(message);
    if (!m) continue;
    const slots = m.slice(1).map((s) => slot(s, lang));
    // 槽位不认识时试下一条句型（如 `after 'y in z'` 先被三槽句型误切，两槽句型可以译）
    if (slots.some((s) => s === null)) continue;
    const out = (lang === 'zh-CN' ? rule.zh : rule.de)(slots as string[]);
    return lang === 'zh-CN' ? spaceQuotes(out) : out;
  }
  return message;
}
