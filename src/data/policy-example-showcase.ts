/**
 * 「静夜思」特色模板（ADR 0060 §8，cloud#830）：李白《静夜思》原诗即一条可保存、可审批、可执行的真实策略，
 * 运行输出诗名「静夜思」。与演示页 /zh/demos/poem 同一份源码与排版（`src/config/jingyesi-poem.ts`）。
 *
 * - **关键词别名（全是结构词，需结构词别名授权）**：床前 → 模块、疑是 → 规则、举头 → 产出、低头 → 返回。
 *   别名规则 v2 允许 zh 下 2–8 个汉字的单词别名（ADR 0060 §5）。
 * - **策略内嵌词汇（两条，随版本保存与审批）**：类型词条 望明月 → Text（返回类型位置按词汇解析）；
 *   字面量宏 思故乡 → 「静夜思」（个人 / 团队词汇没有字面量种类，只有内嵌词汇能写）。
 *   模板应用时只写这一份内嵌词汇，从不写个人或团队词条。
 * - **显示排版（LayoutMap）**：zh 词法把相邻汉字连成一个 token，别名后必须有空格；排版把这些空格隐去、
 *   把结构标点换回原诗标点，显示与原诗逐字相同，编译的仍是带空格的规范源码。
 * - **能力要求**：排版需要结构化编写，四个结构词别名需要结构词别名授权；缺任一项模板在选择器里锁定。
 *
 * 不变式（policy-example-showcase.test.ts 钉死）：source === POEM_ZH.source；aliasSet 过 v2 校验（无授权则
 * structuralNotGranted）；源码仅在 zh-CN + aliasSet + 内嵌词汇齐备时编译，Core IR 的 positionFreeSha256 与
 * ts / core 两侧证明相同；入口「地上霜」求值为「静夜思」；排版通过 validatePolicyLayout，toDisplay 即原诗。
 */
import { JINGYESI_LAYOUT, JINGYESI_SOURCE } from '@/config/jingyesi-poem';
import type { EmbeddedVocabulary } from '@/lib/policy-embedded-vocabulary';
import type { PolicyExample } from './policy-examples';

export const JINGYESI_TEMPLATE_ID = 'showcase-jingyesi';

/** ADR 0060 §8 的 aliasSet：四个领字都是结构词别名。 */
const JINGYESI_ALIAS_SET: Readonly<Record<string, readonly string[]>> = {
  FUNC_PRODUCE: ['举头'],
  FUNC_TO: ['疑是'],
  MODULE_DECL: ['床前'],
  RETURN: ['低头'],
};

/** ADR 0060 §8 的内嵌词汇（顺序即规范序列化的顺序：按 kind 的码点序，literal 在 struct 前）。 */
const JINGYESI_EMBEDDED_VOCABULARY: EmbeddedVocabulary = {
  v: 1,
  terms: [
    { kind: 'literal', localized: '思故乡', canonical: '静夜思' },
    { kind: 'struct', localized: '望明月', canonical: 'Text' },
  ],
};

/** 入口规则「地上霜」没有参数。 */
const JINGYESI_INPUT = {};

export const jingyesiShowcaseExample: PolicyExample = {
  id: JINGYESI_TEMPLATE_ID,
  category: 'showcase',
  groupId: 'showcase',
  // 只有 zh-CN 一种源码：cnlLocale 固定为 zh-CN，三个语种键都指向同一份（getExampleSource 按 cnlLocale 取）。
  sources: { 'en-US': JINGYESI_SOURCE, 'zh-CN': JINGYESI_SOURCE, 'de-DE': JINGYESI_SOURCE },
  cnlLocale: 'zh-CN',
  aliasSet: JINGYESI_ALIAS_SET,
  embeddedVocabulary: JINGYESI_EMBEDDED_VOCABULARY,
  layout: JINGYESI_LAYOUT,
  requires: { structuredAuthoring: true, structuralAliases: true },
  metadata: {
    'en-US': {
      name: 'Quiet Night Thoughts (Chinese showcase)',
      description:
        'Li Bai’s poem, word for word, is the source of a Chinese (zh-CN) policy, and running it outputs the title 静夜思. Four keyword aliases turn the opening words of the lines into keywords. The policy’s own vocabulary maps 望明月 to the Text type and expands the literal 思故乡 to "静夜思". A display layout hides the spaces the aliases need, so the policy reads as the original poem.',
    },
    'zh-CN': {
      name: '静夜思 · 原诗即策略',
      description:
        '李白《静夜思》原诗就是这条策略的源码，运行输出诗名「静夜思」。四个关键词别名把每句的领字变成关键词（床前、疑是、举头、低头）；本策略自带词汇把「望明月」解析为文本类型，并把字面量「思故乡」展开为「静夜思」；显示排版隐去别名后必需的空格，读起来与原诗一字不差。',
    },
    'de-DE': {
      name: 'Gedanken in stiller Nacht (chinesisches Beispiel)',
      description:
        'Li Bais Gedicht ist Wort für Wort der Quelltext einer chinesischen (zh-CN) Richtlinie; beim Ausführen gibt sie den Titel 静夜思 aus. Vier Schlüsselwort-Aliase machen die Anfangswörter der Verse zu Schlüsselwörtern. Das eigene Vokabular der Richtlinie bildet 望明月 auf den Typ Text ab und erweitert das Literal 思故乡 zu „静夜思“. Ein Anzeigelayout blendet die Leerzeichen aus, die die Aliase brauchen, sodass die Richtlinie wie das Originalgedicht aussieht.',
    },
    'hi-IN': {
      name: 'शांत रात के विचार (चीनी उदाहरण)',
      description:
        'ली बाई की कविता, शब्दशः, एक चीनी (zh-CN) नीति का स्रोत है, और इसे चलाने पर शीर्षक 静夜思 मिलता है। चार कीवर्ड उपनाम पंक्तियों के पहले शब्दों को कीवर्ड बनाते हैं। नीति की अपनी शब्दावली 望明月 को Text प्रकार से जोड़ती है और लिटरल 思故乡 को "静夜思" में बदलती है। डिस्प्ले लेआउट उपनामों के लिए ज़रूरी रिक्त स्थान छिपाता है, ताकि नीति मूल कविता जैसी पढ़ी जाए।',
    },
  },
  defaultInputs: { 'en-US': JINGYESI_INPUT, 'zh-CN': JINGYESI_INPUT, 'de-DE': JINGYESI_INPUT },
};
