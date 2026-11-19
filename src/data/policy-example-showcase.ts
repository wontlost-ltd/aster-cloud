/**
 * 结构化编写展示模板（#791）：《静夜思》（李白，公有领域）写成一条**可保存的真实策略**。
 *
 * 与 /demos/poem 的区别：演示页用单字关键词别名、字面量宏与内联词汇，这些都过不了真实策略的
 * 保存门禁。这里按今天的规则重写：
 *
 * - **结构体即诗**：`模块 床前明月光` 是第一句；`定义 地上霜 包含 举头望明月，低头思故乡` 是后三句（源码按诗分行）——
 *   结构体「地上霜」的两个字段就是第三、四句。规则「吟」读这个结构体。
 * - **关键词别名只用运算符类**：`接 着` → PLUS（多词、白名单内、恒允许），不需要结构词别名授权。
 *   规则体 `夜.举头望明月 接 着 夜.低头思故乡` 去掉别名就无法解析，别名是承重的。
 * - **显示排版（LayoutMap）**：结构 span 只覆盖关键词、标点与空白——`模块 ` 隐去，`定义 ` 显示为「疑是」，
 *   `包含`/逗号/句号换成诗的标点与换行，别名 `接 着` 显示为「接着」；全部名字（内容 span）原样可见。
 *   toDisplay 的前四行就是原诗，其后是规则原文。
 * - **不含领域词汇**：内置 zh-CN 词汇（finance.loan / insurance.auto）只有显式传 domain 时才生效，
 *   策略编辑器与保存编译门禁都不传 domain、只用作者自己的词条；模板又不得替用户写词条。
 *   因此词汇不进模板，描述里指向「词汇」标签页与文档。
 *
 * 不变式（policy-example-showcase.test.ts 钉死）：toCanonical(layout) === source；源码以 zh-CN + aliasSet
 * 编译零诊断；layout 以 zh-CN + 冻结 aliasSet 通过 validatePolicyLayout，去掉 aliasSet 则被拒。
 */
import type { PolicyLayout } from '@aster-cloud/aster-lang-ts/layout';
import type { PolicyExample } from './policy-examples';

export const JINGYESI_TEMPLATE_ID = 'showcase-jingyesi';

/** 规则体用的多词运算符别名：`接 着` = 加上（PLUS，文本拼接）。 */
const JINGYESI_ALIAS_SET: Readonly<Record<string, readonly string[]>> = {
  PLUS: ['接 着'],
};

/** 结构 span 只放关键词/标点/空白；名字与字面量一律走内容 span（`layout_structural_hides_value`）。 */
const JINGYESI_LAYOUT: PolicyLayout = {
  v: 1,
  spans: [
    { canonical: '模块 ', display: '' },
    { text: '床前明月光' },
    { canonical: '。\n\n定义 ', display: '，\n疑是' },
    { text: '地上霜' },
    { canonical: ' 包含\n  ', display: '。\n' },
    { text: '举头望明月' },
    { canonical: '，\n  ', display: '，\n' },
    { text: '低头思故乡' },
    { canonical: '。', display: '。' },
    { text: '\n\n规则 吟 给定 夜 作为 地上霜，产出 文本：\n  返回 夜.举头望明月 ' },
    { canonical: '接 着', display: '接着' },
    { text: ' 夜.低头思故乡。\n' },
  ],
};

/** 规范源码（= toCanonical(JINGYESI_LAYOUT)），编辑器与保存都用它。 */
const JINGYESI_SOURCE = `模块 床前明月光。

定义 地上霜 包含
  举头望明月，
  低头思故乡。

规则 吟 给定 夜 作为 地上霜，产出 文本：
  返回 夜.举头望明月 接 着 夜.低头思故乡。
`;

/** 规则只有一个参数「夜」（结构体 地上霜）；执行输出后两句。 */
const JINGYESI_INPUT = { 夜: { 举头望明月: '举头望明月，', 低头思故乡: '低头思故乡。' } };

export const jingyesiShowcaseExample: PolicyExample = {
  id: JINGYESI_TEMPLATE_ID,
  category: 'showcase',
  groupId: 'showcase',
  // 只有 zh-CN 一种源码：cnlLocale 固定为 zh-CN，三个语种键都指向同一份（getExampleSource 按 cnlLocale 取）。
  sources: { 'en-US': JINGYESI_SOURCE, 'zh-CN': JINGYESI_SOURCE, 'de-DE': JINGYESI_SOURCE },
  cnlLocale: 'zh-CN',
  aliasSet: JINGYESI_ALIAS_SET,
  layout: JINGYESI_LAYOUT,
  requires: { structuredAuthoring: true },
  metadata: {
    'en-US': {
      name: 'Quiet Night Thoughts (Chinese showcase)',
      description:
        'A Chinese (zh-CN) policy built from Li Bai’s poem to show structured authoring. The module and a Define struct hold the poem lines. A rule joins them with a multi-word keyword alias, and a display layout shows the keywords and punctuation as the poem. Domain vocabulary is not included. Use the Vocabulary tab and the docs for that.',
    },
    'zh-CN': {
      name: '静夜思 · 结构化编写示例',
      description:
        '把《静夜思》写成一条真实策略：模块与结构体「地上霜」组成诗句，规则用多词关键词别名「接 着」（加上）拼接诗行，显示排版把关键词与标点排成原诗。模板不含领域词汇，可在「词汇」标签页与文档中了解。',
    },
    'de-DE': {
      name: 'Gedanken in stiller Nacht (chinesisches Beispiel)',
      description:
        'Eine chinesische (zh-CN) Richtlinie aus Li Bais Gedicht, die Strukturiertes Verfassen zeigt. Modul und ein Define-Struct enthalten die Verse. Eine Regel verbindet sie mit einem mehrteiligen Schlüsselwort-Alias, und ein Anzeigelayout zeigt Schlüsselwörter und Satzzeichen als Gedicht. Domänenvokabular ist nicht enthalten. Siehe dazu den Tab „Vokabular“ und die Dokumentation.',
    },
    'hi-IN': {
      name: 'शांत रात के विचार (चीनी उदाहरण)',
      description:
        'ली बाई की कविता से बनी एक चीनी (zh-CN) नीति, जो संरचित लेखन दिखाती है। मॉड्यूल और एक Define struct में कविता की पंक्तियाँ हैं। एक नियम उन्हें बहु-शब्द कीवर्ड उपनाम से जोड़ता है, और डिस्प्ले लेआउट कीवर्ड और विराम चिह्नों को कविता की तरह दिखाता है। डोमेन शब्दावली शामिल नहीं है। उसके लिए शब्दावली टैब और दस्तावेज़ देखें।',
    },
  },
  defaultInputs: { 'en-US': JINGYESI_INPUT, 'zh-CN': JINGYESI_INPUT, 'de-DE': JINGYESI_INPUT },
};
