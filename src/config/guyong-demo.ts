/**
 * 「原创歌词即源码」demo 配置（中文 zh 专属）——《孤勇》(原创词：本项目原创，非任何既有歌曲)。
 *
 * 范式 = **alias-literal（源码即诗 + 字面量宏）+ LayoutMap（显示/编译解耦）**（同静夜思）：
 * 一段**原创**押韵短诗按词序即源码。关键词别名（ADR 0022）把每句领字变结构关键词，
 * **字面量宏**（IdentifierKind.LITERAL）把末句触发词就地展开成一句主题句；运行入口规则输出该句。
 *
 * ★保留一点互动：提供三个**原创**触发词变体（不回头/不停走/不弃守），各经字面量宏展开成一句
 *   押韵主题句。用户切换触发词 → 源码末词随之变 → 点运行，引擎真编译 + 真展开对应主题句输出。
 *   每个变体都是真实字面量宏（引擎真展开），诚实可验，非页面预置文案。
 *
 * ★歌词原创声明：全部歌词为本项目原创，从零创作，不取自任何既有歌曲；主题「孤勇与救赎」。
 *
 * ★LayoutMap：页面**显示** toDisplay（脚手架隐成标点/换行，读成工整押韵短诗），引擎**编译**
 *   toCanonical（语法必需的带空格规范源码）。不变式：toCanonical(layoutFor(变体)) === sourceFor(变体)。
 *
 * ★诚实契约（已用生产同款 TS 引擎实证，见 guyong-demo.compile.test.ts）：
 *  1. 每个触发词变体的诗体源码用《孤勇》别名词典 + 字面量宏词汇编译成功（无诊断错误）。
 *  2. 歌词体版 ≡ 规范关键词版（剥 origin 后结构一致 Core IR）——别名/宏只在 canonicalize 表层。
 *  3. 字面量宏真实生效：源码含触发词但不含展开主题句，规范版含主题句，运行输出 = 宏内容。
 *  4. LayoutMap 不变式：toCanonical(layout) 逐字 === activeSource；toDisplay 保留全部意象内容 span。
 *
 * 别名：孤身→模块 / 我曾问→规则 / 心里→产出(produce) / 记着→令 / 是→定义为 / 答一句→返回。
 */
import { ZH_CN, IdentifierKind } from '@aster-cloud/aster-lang-ts/browser';
import type { Lexicon, DomainVocabulary } from '@aster-cloud/aster-lang-ts/browser';
import { toCanonical, type LayoutSpan, type PolicyLayout } from '@aster-cloud/aster-lang-ts/layout';

/** SemanticTokenKind 字面量（与 poem-demo 的 K 对齐，避免运行时依赖内部枚举）。 */
const K = {
  MODULE_DECL: 'MODULE_DECL',
  FUNC_TO: 'FUNC_TO',
  FUNC_PRODUCE: 'FUNC_PRODUCE',
  LET: 'LET',
  BE: 'BE',
  RETURN: 'RETURN',
} as const;

/** 一个触发词变体：触发词（源码里出现）+ 字面量宏展开的押韵主题句（运行输出）。 */
export interface GuyongVariant {
  /** 触发词（源码末句可见，如 '不回头'）。展示为可切换按钮。 */
  trigger: string;
  /** 字面量宏展开的主题句（= evaluate 结果，CI 锁定）。源码里**不含**它。 */
  themeLine: string;
}

/** 《孤勇》alias-literal demo 的完整配置。 */
export interface GuyongConfig {
  /** 标题（展示）。 */
  title: string;
  /** 题解（展示）。 */
  attribution: string;
  /** 叠加《孤勇》别名的 Lexicon。 */
  lexicon: Lexicon;
  /** 词汇表 id（= lexicon.id = domain = tenantId；compile 用 lexicon.id 查字面量宏）。 */
  domain: string;
  /** 三个触发词变体（各含触发词 + 展开主题句）。 */
  variants: GuyongVariant[];
  /**
   * 给定触发词，产出该变体的**字面量宏词汇表**（IdentifierKind.LITERAL）。compile 前 registerCustom，
   * 并以 domain/tenantId 触发展开。vocab.locale 须 = lexicon.id。
   */
  vocabFor: (variant: GuyongVariant) => DomainVocabulary;
  /**
   * 给定触发词，产出该变体的**歌词体源码**（带语法必需空格；= toCanonical(layoutFor(变体))）。
   * 源码含触发词但不含展开主题句（字面量宏未展开）。
   */
  sourceFor: (variant: GuyongVariant) => string;
  /** 给定触发词，产出该变体的**规范关键词版**（证明歌词体 ≡ 规范版；含展开主题句）。 */
  canonicalFor: (variant: GuyongVariant) => string;
  /** 给定触发词，产出该变体的 LayoutMap（显示走 toDisplay=工整押韵短诗，编译走 toCanonical=source）。 */
  layoutFor: (variant: GuyongVariant) => PolicyLayout;
  /** 入口 rule 名（规范名；各变体共用）。 */
  entry: string;
}

const GUYONG_ZH = 'guyong-zh';

const SP: LayoutSpan = { canonical: ' ', display: '' };

/**
 * 三个**原创**触发词变体。三句主题句工整对仗（纵…，纵…，我亦不…）、押 -ou 韵（头/走/守），
 * 供「保留一点互动」的切换。全部本项目原创，从零创作。
 */
const VARIANTS: GuyongVariant[] = [
  { trigger: '不回头', themeLine: '纵长夜无灯，纵四野无声，我亦不回头' },
  { trigger: '不停走', themeLine: '纵霜雪封城，纵千山万壑，我亦不停走' },
  { trigger: '不弃守', themeLine: '纵孤影独行，纵前路无人，我亦不弃守' },
];

/**
 * 《孤勇》LayoutMap 生成器：给定触发词，`toCanonical` 精确复原该变体 source（带空格规范源码），
 * `toDisplay` 隐去语法脚手架、把结构标点换回诗歌标点，呈现工整押韵短诗。
 * 意象内容 span（孤身/入夜的城/归途/远方的灯/脚下的路/触发词）逐字保留（诚实，不隐语义）。
 * 不变式（compile 测试钉死）：toCanonical(layoutFor(v)) === sourceFor(v)。
 */
function layoutForTrigger(trigger: string): PolicyLayout {
  return { v: 1, spans: [
    { text: '孤身' }, SP, { text: '入夜的城' }, { canonical: '。\n', display: '，\n' },
    // 规则头：`我曾问 归途 心里:`（我曾问→规则、心里→produce 隐；归途 是意象内容，露）。
    { canonical: '我曾问 ', display: '我曾问' }, { text: '归途' }, { canonical: ' 心里', display: '，心里记着' },
    { canonical: ':\n  ', display: '：\n' },
    // let 灯：`记着 灯 是 「远方的灯」`（记着/是 隐；灯 与「远方的灯」是意象内容，露）。
    { canonical: '记着 ', display: '' }, { text: '灯' }, { canonical: ' 是 ', display: '，是那盏' },
    { text: '「远方的灯」' }, { canonical: '。\n  ', display: '；\n' },
    // let 路：`记着 路 是 「脚下的路」`
    { canonical: '记着 ', display: '' }, { text: '路' }, { canonical: ' 是 ', display: '，是这条' },
    { text: '「脚下的路」' }, { canonical: '。\n  ', display: '。\n' },
    // return：`答一句 <触发词>`（答一句→返回 隐；触发词是意象内容，露）。
    { canonical: '答一句 ', display: '我只答一句：' }, { text: trigger }, { canonical: '。', display: '。' },
  ] };
}

/**
 * 《孤勇》——原创押韵短诗逐字即源码（本项目原创，从零创作，非任何既有歌曲）。
 * 显示层（toDisplay，脚手架经 LayoutMap 隐去后，以「不回头」变体为例）读作：
 *   孤身入夜的城，
 *   我曾问归途，心里记着：
 *   灯，是那盏「远方的灯」；
 *   路，是这条「脚下的路」。
 *   我只答一句：不回头。
 * 领字经别名变结构关键词；末句触发词经字面量宏展开成一句押韵主题句，运行输出该句。
 */
export const GUYONG: GuyongConfig = {
  title: '孤勇 · 原创歌词即源码',
  attribution: '本项目原创词（从零创作，非既有歌曲）· 源码即诗，切换触发词、运行输出主题句',
  lexicon: {
    ...ZH_CN,
    id: GUYONG_ZH,
    name: '孤勇（中文）',
    aliases: {
      [K.MODULE_DECL]: ['孤身'], // 「孤身 入夜的城」→ 模块
      [K.FUNC_TO]: ['我曾问'], // 「我曾问 归途」→ 规则
      [K.FUNC_PRODUCE]: ['心里'], // 「…心里:」→ 产出（块起始，紧贴冒号）
      [K.LET]: ['记着'], // 「记着 灯 是…」→ 令
      [K.BE]: ['是'], // 「记着 灯 是 …」→ 定义为（绑定运算符）
      [K.RETURN]: ['答一句'], // 「答一句 <触发词>」→ 返回
    },
  } as Lexicon,
  domain: GUYONG_ZH,
  variants: VARIANTS,
  vocabFor: (v) => ({
    id: GUYONG_ZH,
    name: '孤勇',
    locale: GUYONG_ZH,
    version: '1.0.0',
    structs: [],
    fields: [],
    functions: [],
    enumValues: [],
    // 字面量宏：触发词 → 押韵主题句。locale 须 = lexicon.id（compile 用 lexicon.id 查词汇）。
    literals: [{ localized: v.trigger, canonical: v.themeLine, kind: IdentifierKind.LITERAL }],
  }),
  sourceFor: (v) => `孤身 入夜的城。
我曾问 归途 心里:
  记着 灯 是 「远方的灯」。
  记着 路 是 「脚下的路」。
  答一句 ${v.trigger}。`,
  canonicalFor: (v) => `模块 入夜的城。
规则 归途 产出:
  令 灯 定义为 「远方的灯」。
  令 路 定义为 「脚下的路」。
  返回 「${v.themeLine}」。`,
  layoutFor: (v) => layoutForTrigger(v.trigger),
  entry: '归途',
};

/** 供测试断言 LayoutMap 不变式：某变体的编译源码 = toCanonical(layoutFor(变体))。 */
export function guyongCompileSource(variant: GuyongVariant): string {
  return toCanonical(GUYONG.layoutFor(variant));
}
