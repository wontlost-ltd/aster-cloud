// 🐱 猫咪心情引擎 fun-demo 数据 + 逻辑。
//
// 一个不太正经的彩蛋：用「撸猫领域」的术语写一条决定猫此刻心情的规则，浏览器引擎注入
// 这套猫词汇后真编译真执行，决策驱动一段 5 秒简笔猫动画。证明「领域词汇」可以是任何领域
// ——哪怕是猫。诗意诙谐，但底层和信贷 demo 同一套引擎、同样可证明。
//
// 技术契约（已用生产引擎实证，见 cat-mood.compile.test.ts）：
//  1. 规则用**撸猫术语**（localized）+ 对应语言 CNL 关键词书写；compile({lexicon,domain,
//     tenantId}) 取经 registerCustom 注入的猫词汇，引擎按名字所在位置（ADR 0051）解析为 canonical IR。
//  2. eval 输入用 **canonical 字段名**（belly/sunbeam/strangers，非 tummyFullness）。
//  3. 规则逐档 If 是为了与 CAT_TIERS 的优先级一一对应；德文标识符避 ue/ae/oe。

import {
  vocabularyRegistry,
  EN_US, ZH_CN, DE_DE,
  type Lexicon,
} from '@/lib/aster-lexicon';
import {
  assembleDomainVocabularyFromLinks,
  type TermLikeRow,
} from '@/lib/domain-vocabulary-assemble';

export type DemoLocale = 'en' | 'zh' | 'de';

export function toDemoLocale(locale: string): DemoLocale {
  const l = locale.toLowerCase();
  if (l.startsWith('zh')) return 'zh';
  if (l.startsWith('de')) return 'de';
  return 'en';
}

const LEXICONS: Record<DemoLocale, Lexicon> = { en: EN_US, zh: ZH_CN, de: DE_DE };
const LOCALE_TAGS: Record<DemoLocale, string> = { en: 'en-US', zh: 'zh-CN', de: 'de-DE' };

export const CAT_DEMO_TENANT = 'cat-mood-anon';
export const CAT_DOMAIN = 'cat.mood';

/** 五种猫心情（决策 key → 动画）。perch=登高，走到爬架爬上顶窝。 */
export type CatMood = 'perch' | 'floof' | 'loaf' | 'purr' | 'judge';

/** 撸猫领域术语：canonical 跨语言不变，localized 是各语言可爱说法。 */
interface CatTerm {
  kind: 'struct' | 'field';
  canonical: string;
  parent?: string;
  localized: Record<DemoLocale, string>;
}

// de localized 名避开 ue/ae/oe（canonicalizer 会转 ü/ä/ö，毁掉 eval 键）：
// bauchFulle（非 bauchFuelle）、sonnenWarme（非 sonnenWaerme）。
export const CAT_TERMS: CatTerm[] = [
  { kind: 'struct', canonical: 'CatState', localized: { en: 'Kitty', zh: '主子', de: 'Mieze' } },
  { kind: 'field', canonical: 'belly', parent: 'CatState', localized: { en: 'tummyFullness', zh: '肚皮饱度', de: 'bauchFulle' } },
  { kind: 'field', canonical: 'sunbeam', parent: 'CatState', localized: { en: 'sunPatchWarmth', zh: '阳光斑温度', de: 'sonnenWarme' } },
  { kind: 'field', canonical: 'strangers', parent: 'CatState', localized: { en: 'intruderCount', zh: '陌生人数', de: 'eindringlinge' } },
  { kind: 'field', canonical: 'perchUrge', parent: 'CatState', localized: { en: 'highGroundUrge', zh: '登高欲', de: 'kletterLust' } },
];

/** 某语言下的规则 + 函数/参数名。 */
export interface CatRule {
  source: string;
  ruleName: string;
  paramName: string;
}

/** 决策档（声明式，回放 + 一致性用）。 */
export interface CatTier {
  mood: CatMood;
  field?: string;       // canonical；兜底档无
  op?: '>=';
  threshold?: number;
}

export const CAT_TIERS: CatTier[] = [
  { mood: 'perch', field: 'perchUrge', op: '>=', threshold: 1 }, // 登高欲最高优先：先爬架
  { mood: 'floof', field: 'strangers', op: '>=', threshold: 1 },
  { mood: 'loaf', field: 'sunbeam', op: '>=', threshold: 7 },
  { mood: 'purr', field: 'belly', op: '>=', threshold: 8 },
  { mood: 'judge' }, // 兜底：既不想登高、又无人闯入、又没阳光、又没吃饱 → 高冷审视
];

export const CAT_RULES: Record<DemoLocale, CatRule> = {
  en: {
    ruleName: 'mood', paramName: 'moggy',
    source: `Module cat.mood.

Define Kitty has
  tummyFullness as Int,
  sunPatchWarmth as Int,
  intruderCount as Int,
  highGroundUrge as Int.

Rule mood given moggy as Kitty, produce Text:
  If moggy.highGroundUrge at least 1:
    Return "perch".
  If moggy.intruderCount at least 1:
    Return "floof".
  If moggy.sunPatchWarmth at least 7:
    Return "loaf".
  If moggy.tummyFullness at least 8:
    Return "purr".
  Return "judge".
`,
  },
  zh: {
    ruleName: '心情', paramName: '喵主子',
    source: `模块 猫.心情。

定义 主子 包含
  肚皮饱度 作为 整数，
  阳光斑温度 作为 整数，
  陌生人数 作为 整数，
  登高欲 作为 整数。

规则 心情 给定 喵主子 作为 主子 产出 文本：
  如果 喵主子.登高欲 至少 1：
    返回 "perch"。
  如果 喵主子.陌生人数 至少 1：
    返回 "floof"。
  如果 喵主子.阳光斑温度 至少 7：
    返回 "loaf"。
  如果 喵主子.肚皮饱度 至少 8：
    返回 "purr"。
  返回 "judge"。
`,
  },
  de: {
    ruleName: 'stimmung', paramName: 'kater',
    source: `Modul katze.stimmung.

Definiere Mieze hat
  bauchFulle als Ganzzahl,
  sonnenWarme als Ganzzahl,
  eindringlinge als Ganzzahl,
  kletterLust als Ganzzahl.

Regel stimmung gegeben kater als Mieze liefert Text:
  wenn kater.kletterLust mindestens 1:
    gib zurück "perch".
  wenn kater.eindringlinge mindestens 1:
    gib zurück "floof".
  wenn kater.sonnenWarme mindestens 7:
    gib zurück "loaf".
  wenn kater.bauchFulle mindestens 8:
    gib zurück "purr".
  gib zurück "judge".
`,
  },
};

/** demo 预设场景（canonical-key 输入 + 预期心情）。 */
export interface CatScene {
  id: CatMood;
  input: Record<string, number>;
}

export const CAT_SCENES: CatScene[] = [
  { id: 'perch', input: { belly: 6, sunbeam: 3, strangers: 0, perchUrge: 1 } }, // 想登高 → 爬上爬架顶窝
  { id: 'purr', input: { belly: 9, sunbeam: 3, strangers: 0, perchUrge: 0 } },  // 吃饱了 → 呼噜
  { id: 'loaf', input: { belly: 5, sunbeam: 9, strangers: 0, perchUrge: 0 } },  // 暖阳里 → 摊成猫面包
  { id: 'floof', input: { belly: 9, sunbeam: 9, strangers: 2, perchUrge: 0 } }, // 有人闯入 → 炸毛
  { id: 'judge', input: { belly: 3, sunbeam: 2, strangers: 0, perchUrge: 0 } }, // 啥也不满足 → 高冷审视
];

/** 注入猫词汇到引擎，返回当前语言的 registry domain key。 */
export function registerCatVocab(loc: DemoLocale): string {
  const localeTag = LOCALE_TAGS[loc];
  const key = `${CAT_DOMAIN}-${loc}`;
  const rows: TermLikeRow[] = CAT_TERMS.map((t, i) => ({
    domainTermId: `${key}-${i}`,
    domain: key,
    locale: localeTag,
    kind: t.kind,
    canonical: t.canonical,
    localized: t.localized[loc],
    parentCanonical: t.parent ?? null,
  }));
  vocabularyRegistry.registerCustom(CAT_DEMO_TENANT, assembleDomainVocabularyFromLinks(rows, { domain: key, locale: localeTag, name: key }));
  return key;
}

export function catLexiconFor(loc: DemoLocale): Lexicon {
  return LEXICONS[loc];
}

/** canonical 字段 → 当前语言撸猫说法（输入展示用）。 */
export function catTermLabel(canonical: string, loc: DemoLocale): string {
  return CAT_TERMS.find((t) => t.canonical === canonical)?.localized[loc] ?? canonical;
}

/** 当前语言规则里的领域术语（高亮用）。 */
export function catVocabTerms(loc: DemoLocale): string[] {
  return CAT_TERMS.map((t) => t.localized[loc]);
}

/** 确定性镜像：按档求出心情（与引擎一致性参照）。 */
export function catMoodOf(input: Record<string, number>): CatMood {
  for (const tier of CAT_TIERS) {
    if (tier.field === undefined) return tier.mood; // 兜底
    if ((input[tier.field] ?? 0) >= (tier.threshold ?? 0)) return tier.mood;
  }
  return 'judge';
}
