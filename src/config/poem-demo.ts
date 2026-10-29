/**
 * 「源码即诗」demo 配置（公开，四语：en/zh/de/hi），三种范式：
 *
 * **computed**（en）——一首**连贯**递归谣曲，每段**上半诗句、下半真计算**：无括号 `apply`
 *   递归织段。诗读连贯，但每次调用、每次拼接都是引擎真求值——不是预写诗句的打印。
 *
 * **alias-literal**（zh《静夜思》李白 / hi《गीतांजलि #35》泰戈尔，均公有领域）——整首诗按
 *   **原词序**即源码：关键词别名把诗句领字变结构关键词，**字面量宏**（IdentifierKind.LITERAL）
 *   把末词展开成字符串字面量（思故乡→"静夜思"；जागे→英文结句），运行输出名句。
 *
 * **decision**（de《Du bist mein, ich bin dein》，中世纪情诗，公有领域）——整首诗即一条**裁决
 *   规则**：诗的四个前提当布尔输入，关键词别名把领字变结构关键词，引擎 let 绑定推导中间值再
 *   wenn/sonst 真判定，输出「für immer」或「nicht auf ewig」。翻任一前提裁决即变（真计算）。
 *
 * 三种范式都靠 canonicalize 归一：关键词别名（ADR 0022）+ 无括号 apply（ADR 0027）+ 字面量宏
 * 只在表层，Lexer/Parser/Core IR 不知其存在 → 诗体版 ≡ 规范版（结构一致 Core IR）。客户端浏览器
 * 内 TS 引擎，即时可验。
 */
import { EN_US, ZH_CN, DE_DE, HI_IN, IdentifierKind } from '@aster-cloud/aster-lang-ts/browser';
import type { Lexicon, DomainVocabulary } from '@aster-cloud/aster-lang-ts/browser';
import type { LayoutSpan } from '@/lib/layout-map';

export type PoemLocale = 'en' | 'zh' | 'de' | 'hi';

/** 把 next-intl 的 locale 收敛到本 demo 支持的四语（未知回退 en）。 */
export function toPoemLocale(locale: string): PoemLocale {
  const l = locale.toLowerCase();
  if (l.startsWith('zh')) return 'zh';
  if (l.startsWith('de')) return 'de';
  if (l.startsWith('hi')) return 'hi';
  return 'en';
}

/** SemanticTokenKind 字面量（避免运行时依赖内部枚举；值与 token-kind.ts 对齐）。 */
const K = {
  MODULE_DECL: 'MODULE_DECL',
  FUNC_TO: 'FUNC_TO',
  FUNC_GIVEN: 'FUNC_GIVEN',
  FUNC_PRODUCE: 'FUNC_PRODUCE',
  IF: 'IF',
  LET: 'LET',
  BE: 'BE',
  RETURN: 'RETURN',
  MATCH: 'MATCH',
  WHEN: 'WHEN',
  PLUS: 'PLUS',
  MINUS_WORD: 'MINUS_WORD',
  AT_MOST: 'AT_MOST',
  APPLY: 'APPLY',
} as const;

/** 一次运行的样本：入参值 + 运行输出 + 这一遍背后「在做什么」的说明。 */
export interface PoemSample {
  /** 入口 rule 的入参值（computed 范式=计算驱动的量；alias-literal 范式=第几遍吟诵）。 */
  input: number;
  /**
   * 运行输出（引擎真求值结果，逐字一致，CI 锁定）。computed 范式=该入参算出的整首诗；
   * alias-literal 范式=诗名（恒定，宏展开与入参无关）。
   */
  woven: string;
  /** 这一遍背后「在算什么 / 展开了什么」的本地化短说明（trace 展示用，非诗本身）。 */
  computed: string;
}

/** decision 范式的一个可拨动布尔前提（诗句的一个条件）。 */
export interface DecisionToggle {
  /** 规范入参名（传给 evaluate，如 'mein'）。 */
  name: string;
  /** 展示给用户的诗句短语（如 'Du bist mein'）。 */
  label: string;
}

/** decision 范式的一个引擎推导中间值（let 绑定的结果，供展示）。 */
export interface DecisionDerived {
  /** 中间值名（规范，如 'gehoert'）。 */
  name: string;
  /** 展示标签（如 'gehoert = mein und dein'）。 */
  label: string;
  /** 由哪些 toggle 名以 AND 组合得出（用于前端复算展示，非引擎真值——真值仍由 evaluate 给）。 */
  from: string[];
}

/** decision 范式：诗的前提当布尔输入，引擎真推导出裁决。 */
export interface DecisionSpec {
  /** 可拨动的布尔前提（诗句条件）。 */
  toggles: DecisionToggle[];
  /** 引擎推导的中间值（展示 let 绑定过程）。 */
  derived: DecisionDerived[];
  /** 全部前提为真时的裁决文本（= evaluate 结果，CI 锁定）。 */
  verdictAll: string;
  /** 任一前提为假时的裁决文本（= evaluate 结果，CI 锁定）。 */
  verdictElse: string;
}

/**
 * 一首「诗即代码」的完整 demo 配置。
 *
 * 三种范式：
 *  - `computed`（en）：诗句上半是诗、下半是真计算（递归 apply），每个 input 算出不同整首诗。
 *  - `alias-literal`（zh《静夜思》/ hi《गीतांजलि #35》）：整首诗按**原词序**即源码，关键词别名把
 *    诗句领字变结构关键词，**字面量宏**（IdentifierKind.LITERAL）把末词展开成字符串字面量
 *    （思故乡→"静夜思"；जागे→英文结句）；运行输出名句。
 *  - `decision`（de《Du bist mein》）：中世纪情诗即一条**裁决规则**——诗的四个前提（mein/dein/
 *    im Herzen/Schlüssel verloren）当布尔输入，引擎 let 绑定推导（gehoert/verschlossen）再 if/else
 *    真判定，输出「für immer」或「nicht auf ewig」。翻任一前提裁决即变——真计算，非回声。
 */
export interface PoemConfig {
  /** 诗名（展示用）。 */
  title: string;
  /** 题解 / 主题（展示用）。 */
  attribution: string;
  /** 叠加诗词别名的 Lexicon。 */
  lexicon: Lexicon;
  /**
   * 范式：'computed'（计算驱动，每 input 不同）/ 'alias-literal'（源码即诗 + 字面量宏，运行输出
   * 诗名）/ 'decision'（前提当布尔输入，引擎真推导裁决）。缺省 'computed'（向后兼容）。
   */
  paradigm?: 'computed' | 'alias-literal' | 'decision';
  /**
   * 可选：字面量宏词汇表（IdentifierKind.LITERAL）。存在时 compile 前 registerCustom，
   * 并以 `domain`（= vocab.id）+ `tenantId`（= vocab.id）触发字面量宏展开。
   * 注：aster-lang-ts 的 compile 用 lexicon.id 作 locale 查词汇，故 vocab.locale 须 = lexicon.id。
   */
  vocab?: DomainVocabulary;
  /** decision 范式专属：可拨动前提 + 推导中间值 + 两种裁决文本。 */
  decision?: DecisionSpec;
  /** 诗体源码（连贯一首，Match + List + apply，诗句即代码）。 */
  source: string;
  /**
   * 可选 LayoutMap：源码「显示排版」与「编译规范源码」解耦。存在时页面**显示** `toDisplay(layout)`
   * （如无空格的工整原诗「床前明月光」），而**编译**走 `toCanonical(layout)`（语法必需的带空格版
   * 「床前 明月光」）。用于让 zh 诗真正呈现为原诗排版。不变式:toCanonical(layout) === source。
   */
  layout?: readonly LayoutSpan[];
  /** 规范关键词版（证明诗体版 ≡ 规范版，结构一致 Core IR）。 */
  canonical: string;
  /** 入口 rule 名（规范名；三范式共用）。 */
  entry: string;
  /** 入参名（本地化）。computed / alias-literal 用；decision 范式不用（入参见 decision.toggles）。 */
  param?: string;
  /** computed / alias-literal 的样本（decision 范式不用；其输入见 decision.toggles）。 */
  samples?: PoemSample[];
}

// ── EN — Nightfall（原「源码即诗」递归谣曲，与 examples/alias-poem-story 同源）──────
// 不同于 zh/de/hi 的 Match+List 连贯诗：Nightfall 是一首**递归**谣曲——`gather(stars)` 用无括号
// apply 递归把 n 颗星的光一句一句聚拢，整段源码逐行读是一首诗。诗句是字符串，但递归结构本身
// 就是诗意（夜里一盏盏点灯），输出长短随入参（星数）增长。
const EN_LAST = 'and one last light to keep the dark from me';
const EN_MORE = ' and one more light to set the evening free';
const POEM_EN: PoemConfig = {
  title: 'Nightfall',
  attribution: 'A recursive night-song · the source itself is the poem',
  lexicon: { ...EN_US, id: 'nightfall-en', name: 'Nightfall (English)', aliases: {
    [K.MODULE_DECL]: ['Nightfall'], [K.FUNC_TO]: ['I'], [K.FUNC_GIVEN]: ['count'],
    [K.IF]: ['while'], [K.RETURN]: ['sing'], [K.LET]: ['let'], [K.BE]: ['be'],
    [K.PLUS]: ['with'], [K.MINUS_WORD]: ['less'], [K.AT_MOST]: ['but'], [K.APPLY]: ['echoing'],
  } } as Lexicon,
  source: `Nightfall comes.

I gather count stars:
  while stars but 1
    sing "${EN_LAST}".
  let earlier be echoing gather to stars less 1.
  sing earlier with "${EN_MORE}".`,
  canonical: `Module comes.

Rule gather given stars:
  If stars at most 1
    Return "${EN_LAST}".
  Let earlier be apply gather to stars minus 1.
  Return earlier + "${EN_MORE}".`,
  entry: 'gather', param: 'stars',
  samples: [
    { input: 1, woven: EN_LAST, computed: 'gather(1): base case (stars at most 1) → one last light' },
    { input: 2, woven: EN_LAST + EN_MORE, computed: 'gather(2): light + echoing gather to 1 → one more light' },
    { input: 3, woven: EN_LAST + EN_MORE + EN_MORE, computed: 'gather(3): light + echoing gather to 2 → two more lights, gathered one by one' },
  ],
};

// ── ZH — 静夜思（李白，公有领域）· 源码即诗 + 字面量宏 ────────────────────────
// 整首诗按**原词序**即源码：关键词别名把诗句领字变结构关键词（床前→Module / 疑是→Rule /
// 举头→produce / 低头→Return），**字面量宏**（IdentifierKind.LITERAL）把末词展开成字符串
// 字面量（思故乡→"静夜思"）。运行入口 rule「地上霜」输出诗名「静夜思」。
// 返回类型「望明月」是一条类型词条（规范名 Text）：名称按位置解析（ADR 0051），未知类型名会报
// E800，故由词汇把它解析为内置文本类型。别名、字面量宏与词汇解析都不改变 Core IR 结构 → 诗体版 ≡ 规范版。
const JYS_DOMAIN = 'jingyesi-zh';

/**
 * 静夜思 LayoutMap：`toCanonical` 精确复原 POEM_ZH.source（语法必需的带空格版），
 * `toDisplay` 把四处关键词间空格隐去、把结构标点换回原诗标点，呈现无空格工整原诗
 * （床前明月光，\n 疑是地上霜。\n 举头望明月，\n 低头思故乡。）。
 * 不变式（由 poem-demo.compile.test.ts 钉死）：toCanonical(JINGYESI_LAYOUT) === POEM_ZH.source。
 */
const SP: LayoutSpan = { canonical: ' ', display: '' };
const JINGYESI_LAYOUT: readonly LayoutSpan[] = [
  { text: '床前' }, SP, { text: '明月光' }, { canonical: '。\n', display: '，\n' },
  { text: '疑是' }, SP, { text: '地上霜' }, { canonical: '，', display: '。\n' },
  { text: '举头' }, SP, { text: '望明月' }, { canonical: '：\n  ', display: '，\n' },
  { text: '低头' }, SP, { text: '思故乡' }, { canonical: '。', display: '。' },
];

const POEM_ZH: PoemConfig = {
  title: '静夜思',
  attribution: '李白 · 整首诗即源码，运行输出诗名「静夜思」',
  paradigm: 'alias-literal',
  lexicon: { ...ZH_CN, id: JYS_DOMAIN, name: '静夜思（中文）', aliases: {
    [K.MODULE_DECL]: ['床前'], [K.FUNC_TO]: ['疑是'], [K.FUNC_PRODUCE]: ['举头'],
    [K.RETURN]: ['低头'],
  } } as Lexicon,
  // 字面量宏：思故乡 → 内容「静夜思」；类型词条：望明月 → Text（返回类型位置按词汇解析）。
  vocab: {
    id: JYS_DOMAIN, name: '静夜思', locale: JYS_DOMAIN, version: '1.0.0',
    structs: [{ localized: '望明月', canonical: 'Text', kind: IdentifierKind.STRUCT }],
    fields: [], functions: [], enumValues: [],
    literals: [{ localized: '思故乡', canonical: '静夜思', kind: IdentifierKind.LITERAL }],
  },
  source: `床前 明月光。
疑是 地上霜，举头 望明月：
  低头 思故乡。`,
  // LayoutMap：页面**显示** toDisplay（无空格工整原诗），**编译**走 toCanonical（=上面 source）。
  layout: JINGYESI_LAYOUT,
  canonical: `模块 明月光。
规则 地上霜 产出 文本：
  返回 「静夜思」。`,
  entry: '地上霜', param: '时',
  // alias-literal 范式页面只跑一次（runOnce），不用 samples。这里保留三个**不同** input 仅作
  // 测试夹具：证明字面量宏与入参无关——三个 input 输出恒为诗名「静夜思」（见 compile 测试第 4 条
  // 不变式 wovens.size===1）。computed 字段本范式不在页面渲染。
  samples: [
    { input: 1, woven: '静夜思', computed: '' },
    { input: 2, woven: '静夜思', computed: '' },
    { input: 3, woven: '静夜思', computed: '' },
  ],
};

// ── DE — Du bist mein, ich bin dein（中世纪情诗，约 12 世纪，公有领域）· 诗即裁决规则 ──
// 整首诗按**原词序**即源码，映射成一条**裁决规则**：诗的四个前提（Du bist mein / ich bin dein /
// im Herzen / Schlüssel verloren）当布尔输入，关键词别名把领字变结构关键词，引擎 let 绑定推导
// （gehoert = mein und dein；verschlossen = im Herzen und Schlüssel verloren），再 wenn/sonst
// 真判定输出裁决。翻任一前提裁决即变——这是引擎**真推导**的结论，不是回声。
// 别名只在 canonicalize 表层 → 诗体版 ≡ 规范版 Core IR。
// 注：德语无空格分词故用多词别名吸收领字；变音 ü/ö/ä/ß→ue/oe/ae/ss（德语通行 ASCII 写法），
// 行内逗号（结构符）省去。裁决文本含真变音（在字符串字面量内，安全）。
const LIEBE_DE = 'liebeslied-de';
const POEM_DE: PoemConfig = {
  title: 'Du bist mein, ich bin dein',
  attribution: 'Mittelalterliches Liebeslied (um 1180, gemeinfrei) · das Gedicht ist eine Entscheidungsregel',
  paradigm: 'decision',
  lexicon: { ...DE_DE, id: LIEBE_DE, name: 'Liebeslied (Deutsch)', aliases: {
    [K.MODULE_DECL]: ['du bist mein ich bin'], // „Du bist mein, ich bin dein." → Modul dein
    [K.FUNC_TO]: ['dessen'],                    // „Dessen ... sein." → Regel
    [K.FUNC_GIVEN]: ['sollst du'],              // → gegeben（前提参数表）
    [K.FUNC_PRODUCE]: ['gewiss sein'],          // „... gewiss sein:" → produce（块起始）
    [K.LET]: ['du bist', 'verloren ist das'],   // „Du bist eingeschlossen" / „verloren ist das ..." → sei
    [K.BE]: ['in meinem'],                      // „in meinem Herzen" → be（绑定运算符）
    [K.IF]: ['du musst auch fuer immer darin'], // „Du musst ... darin bleiben" → wenn <cond>
  } } as Lexicon,
  source: `Du bist mein ich bin dein.
Dessen bindung sollst du mein als Boolesch, dein als Boolesch, herz als Boolesch, schluessel als Boolesch, gewiss sein:
  Du bist gehoert in meinem mein und dein.
  verloren ist das verschlossen in meinem herz und schluessel.
  Du musst auch fuer immer darin gehoert und verschlossen:
    gib zurueck "fuer immer".
  sonst:
    gib zurueck "nicht auf ewig".`,
  canonical: `Modul dein.
Regel bindung gegeben mein als Boolesch, dein als Boolesch, herz als Boolesch, schluessel als Boolesch:
  sei gehoert gleich mein und dein.
  sei verschlossen gleich herz und schluessel.
  wenn gehoert und verschlossen:
    gib zurueck "fuer immer".
  sonst:
    gib zurueck "nicht auf ewig".`,
  entry: 'bindung',
  decision: {
    toggles: [
      { name: 'mein', label: 'Du bist mein' },
      { name: 'dein', label: 'ich bin dein' },
      { name: 'herz', label: 'eingeschlossen in meinem Herzen' },
      { name: 'schluessel', label: 'verloren ist das Schlüssellein' },
    ],
    derived: [
      { name: 'gehoert', label: 'gehoert = mein und dein', from: ['mein', 'dein'] },
      { name: 'verschlossen', label: 'verschlossen = im Herzen und Schlüssel verloren', from: ['herz', 'schluessel'] },
    ],
    verdictAll: 'für immer',
    verdictElse: 'nicht auf ewig',
  },
};

// ── HI — गीतांजलि #35（泰戈尔，1910，公有领域）· 源码即诗 + 字面量宏 ─────────────
// 泰戈尔《吉檀迦利》#35「心中无惧」（Where the mind is without fear）的印地语呈现按原词序即
// 源码：关键词别名把每句领字（चित्त जहाँ→Module / मस्तक जहाँ→Rule / ज्ञान जहाँ→Let /
// उस स्वर्ग→Return）变结构关键词，**字面量宏**（IdentifierKind.LITERAL）把末词 जागे 展开成该诗
// 英文结句 "Into that heaven of freedom, let my country awake"。运行入口 rule「उन्नत」输出结句。
// 别名 + 字面量宏都只在 canonicalize 表层 → 诗体版 ≡ 规范版 Core IR。
// 注：天城文关键词别名限 ≤3 词（引擎 ≥4 词天城文短语匹配另有缺陷，本 demo 规避）；जागे 含元音
// 符号(matra)能作字面量宏触发词依赖 aster-lang-ts 1.0.13 的天城文 identifier 修复。
const GITANJALI_HI = 'gitanjali-hi';
const POEM_HI: PoemConfig = {
  title: 'गीतांजलि #35',
  attribution: 'रवीन्द्रनाथ टैगोर (1910, सार्वजनिक डोमेन) · स्रोत ही कविता है, चलाने पर काव्य-पंक्ति देता है',
  paradigm: 'alias-literal',
  lexicon: { ...HI_IN, id: GITANJALI_HI, name: 'गीतांजलि (हिन्दी)', aliases: {
    [K.MODULE_DECL]: ['चित्त जहाँ'], [K.FUNC_TO]: ['मस्तक जहाँ'],
    [K.LET]: ['ज्ञान जहाँ'], [K.BE]: ['बहे'], [K.RETURN]: ['उस स्वर्ग'],
  } } as Lexicon,
  // 字面量宏：जागे → 该诗英文结句。vocab.locale 须 = lexicon.id（compile 用 lexicon.id 查词汇）。
  vocab: {
    id: GITANJALI_HI, name: 'गीतांजलि', locale: GITANJALI_HI, version: '1.0.0',
    structs: [], fields: [], functions: [], enumValues: [],
    literals: [{
      localized: 'जागे',
      canonical: 'Into that heaven of freedom, let my country awake',
      kind: IdentifierKind.LITERAL,
    }],
  },
  source: `चित्त जहाँ निर्भय।
मस्तक जहाँ उन्नत:
  ज्ञान जहाँ मुक्त बहे सत्य।
  उस स्वर्ग जागे।`,
  canonical: `मॉड्यूल निर्भय।
नियम उन्नत:
  मानें मुक्त हो सत्य।
  लौटाएं "Into that heaven of freedom, let my country awake"।`,
  entry: 'उन्नत',
  // alias-literal 范式页面只跑一次（runOnce），不用 samples；保留三个不同 input 仅作测试夹具：
  // 证明字面量宏与入参无关——恒输出英文结句（compile 测试第 4 条 wovens.size===1）。
  samples: [
    { input: 1, woven: 'Into that heaven of freedom, let my country awake', computed: '' },
    { input: 2, woven: 'Into that heaven of freedom, let my country awake', computed: '' },
    { input: 3, woven: 'Into that heaven of freedom, let my country awake', computed: '' },
  ],
};

export const POEMS: Record<PoemLocale, PoemConfig> = {
  en: POEM_EN,
  zh: POEM_ZH,
  de: POEM_DE,
  hi: POEM_HI,
};
