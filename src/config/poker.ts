// 🃏 德州扑克摊牌引擎 fun-demo 数据 + 逻辑。
//
// 又一个不太正经的彩蛋（姊妹篇=猫咪心情引擎 cat-mood.ts）：用「扑克领域」的术语
// 写一条决定**摊牌赢家**的规则，浏览器引擎注入这套扑克词汇后真编译真执行，决策驱动
// 一段牌桌动画——给赢家颁奖杯。证明「领域词汇」可以是任何领域，底层和信贷 demo 同一套
// 可证明引擎。纯客户端、无网络、无 WASM、CSP 友好。
//
// 设计要点（ADR 0024 纯 CNL 重写）：
//  1. **手牌强度评估全在 CNL**：decide 规则收两玩家各 7 张牌，用 List.combinations 枚举
//     C(7,5)=21 个 5 张子集 → 各 classifyScore5 算单调整数 score → List.max 取最佳 5 张。
//     组合学不再留给 JS。底层只调受控、双引擎对等、确定性的集合 builtin。
//  2. 三语 CNL（POKER_RULES）：各语言关键词 + 本地化 helper/字段名；无域词汇注入
//     （用 canonical List.* + 本地化卡牌字段名 直接取，cardsForRule 按 loc 构造）。
//  3. eval 输入=两玩家各 7 张牌的本地化 record 列表（{点数,花色} 等）。
//  4. 客户端 eval 21×classify 步数大 → evaluate 传 {maxSteps} 上调（有界计算非死循环）。
//  5. 德文标识符避 ue/ae/oe（canonicalizer 转 ü/ä/ö 毁 eval 键）。

import {
  EN_US, ZH_CN, DE_DE,
  type Lexicon,
} from '@/lib/aster-lexicon';

export type DemoLocale = 'en' | 'zh' | 'de';

export function toDemoLocale(locale: string): DemoLocale {
  const l = locale.toLowerCase();
  if (l.startsWith('zh')) return 'zh';
  if (l.startsWith('de')) return 'de';
  return 'en';
}

const LEXICONS: Record<DemoLocale, Lexicon> = { en: EN_US, zh: ZH_CN, de: DE_DE };

export const POKER_DEMO_TENANT = 'poker-showdown-anon';

/* ── 牌型 / 发牌（纯 JS） ─────────────────────────────────────────── */

/** 花色：黑桃/红心/方块/梅花。 */
export type Suit = 's' | 'h' | 'd' | 'c';
/** 点数 2..14（J=11 Q=12 K=13 A=14）。 */
export type Rank = number;
export interface Card { rank: Rank; suit: Suit; }

const SUITS: Suit[] = ['s', 'h', 'd', 'c'];

/** 标准扑克手牌类别（9 类，category 越大越强）。 */
export type HandCategory =
  | 'high' | 'pair' | 'twoPair' | 'trips' | 'straight'
  | 'flush' | 'fullHouse' | 'quads' | 'straightFlush';

export const HAND_CATEGORY_ORDER: HandCategory[] = [
  'high', 'pair', 'twoPair', 'trips', 'straight',
  'flush', 'fullHouse', 'quads', 'straightFlush',
];

export interface HandValue {
  category: HandCategory;
  /** 单调整数强度分：category 权重 + 5 张关键牌的字典序 tiebreak。越大越强。 */
  score: number;
  /** 决定这手牌的最佳 5 张（展示/高亮用）。 */
  cards: Card[];
}

const RANK_LABEL: Record<number, string> = {
  11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};
export function rankLabel(r: Rank): string {
  return RANK_LABEL[r] ?? String(r);
}
export const SUIT_GLYPH: Record<Suit, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
export const SUIT_IS_RED: Record<Suit, boolean> = { s: false, h: true, d: true, c: false };

/** 5 张牌求手型值。score 是把 [category, kicker1..5] 编码成单调整数。 */
function rank5(cards: Card[]): HandValue {
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const suits = cards.map((c) => c.suit);
  const isFlush = suits.every((s) => s === suits[0]);

  // 直顺检测（含 A-2-3-4-5 的「轮子」，A 当 1）。
  const uniq = [...new Set(ranks)].sort((a, b) => b - a);
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5; // wheel
  }

  // 点数计数（用于对子/三条/葫芦/四条）。
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  // 按 (出现次数, 点数) 降序——同次数比点数。
  const grouped = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const pattern = grouped.map((g) => g[1]).join(''); // e.g. "32"=葫芦, "41"=四条

  let category: HandCategory;
  if (straightHigh && isFlush) category = 'straightFlush';
  else if (pattern.startsWith('4')) category = 'quads';
  else if (pattern === '32') category = 'fullHouse';
  else if (isFlush) category = 'flush';
  else if (straightHigh) category = 'straight';
  else if (pattern.startsWith('3')) category = 'trips';
  else if (pattern === '221') category = 'twoPair';
  else if (pattern.startsWith('2')) category = 'pair';
  else category = 'high';

  // tiebreak 关键牌：按分组次序展开（四条的 4 张在前、其 kicker 在后…），直顺用 high。
  const tiebreak = straightHigh
    ? [straightHigh]
    : grouped.flatMap(([r, n]) => Array(n).fill(r));
  // 编码：category 占高位，5 个 tiebreak 各占 4 bit（点数 ≤14 < 16）。
  const catIdx = HAND_CATEGORY_ORDER.indexOf(category);
  let score = catIdx;
  for (let i = 0; i < 5; i++) score = score * 16 + (tiebreak[i] ?? 0);

  return { category, score, cards: [...cards].sort((a, b) => b.rank - a.rank) };
}

/** 从 7 张（2 手 + 5 公共）选最佳 5 张。C(7,5)=21 组合，全枚举。 */
export function evaluateBest5(seven: Card[]): HandValue {
  let best: HandValue | null = null;
  const n = seven.length;
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) {
            const v = rank5([seven[a], seven[b], seven[c], seven[d], seven[e]]);
            if (!best || v.score > best.score) best = v;
          }
  return best!;
}

export interface PokerBoard {
  player1: [Card, Card];
  player2: [Card, Card];
  community: [Card, Card, Card, Card, Card];
}

export interface PokerOutcome {
  board: PokerBoard;
  p1: HandValue;
  p2: HandValue;
  /** 1 / 2 / 0(平局)。 */
  winner: 1 | 2 | 0;
}

/**
 * 随机发一局（确定性：传入 rng 以便测试/回放）。default Math.random 仅 UI 端用。
 * 发 9 张互不重复：玩家各 2 + 公共 5。
 */
export function dealRandomBoard(rng: () => number = Math.random): PokerBoard {
  const deck: Card[] = [];
  for (let r = 2; r <= 14; r++) for (const s of SUITS) deck.push({ rank: r, suit: s });
  // Fisher-Yates 取前 9 张。
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const nine = deck.slice(0, 9);
  return {
    player1: [nine[0], nine[1]],
    player2: [nine[2], nine[3]],
    community: [nine[4], nine[5], nine[6], nine[7], nine[8]],
  };
}

/** 评估一局（不经引擎，确定性参照 + UI 兜底）。 */
export function evaluateBoard(board: PokerBoard): PokerOutcome {
  const p1 = evaluateBest5([...board.player1, ...board.community]);
  const p2 = evaluateBest5([...board.player2, ...board.community]);
  const winner: 1 | 2 | 0 = p1.score > p2.score ? 1 : p2.score > p1.score ? 2 : 0;
  return { board, p1, p2, winner };
}

/* ── 纯 CNL 牌型判定规则 ─────────────────────────────────────────── */
//
// 重写要点（ADR 0024 受控 stdlib）：手牌强度评估**全在 CNL**——不再把组合学留 JS。
// `decide` 规则收两玩家各 7 张牌（2 手+5 公共），用 List.combinations 枚举 C(7,5)=21 个
// 5 张子集，各 classify 算单调整数 score（牌型类别<<高位 + 5 张关键牌字典序 tiebreak），
// 取最大分=该玩家牌力，再比两玩家。证明「算法级决策逻辑」可完全表达在可读、可证明、
// 双引擎一致的 CNL 里——不靠 JS 黑盒。底层只调受控、确定性、双引擎对等的集合 builtin
// （List.combinations/map/groupBy/distinct/sort/sortBy/max/min/reduce + Map.values + 算术）。
//
// 每语言：CNL 源用该语言关键词；helper/规则名/参数名/字段名是该语言的标识符（不得与
// 关键词或域术语同形）。**卡牌字段名也本地化**（en rank/suit、zh 点数/花色、de wert/farbe）：
// JS 端按 loc 构造对应字段名的卡牌 record 喂给规则，CNL 里 `牌.点数` 直接取（无需域词汇映射）。

/** 决策结果（canonical 字符串，跨语言不变；动画/文案据此分支）。 */
export type PokerVerdict = 'player1' | 'player2' | 'tie';

export interface PokerRule {
  /** 该语言的完整纯 CNL 源（含 helper 规则链 + 顶层 decide）。 */
  source: string;
  /** 顶层判定规则名（evaluate 调用名）。 */
  ruleName: string;
  /** 顶层规则参数名（台面/桌）。 */
  tableParam: string;
  /** 台面 record 里两玩家牌列表的字段名。 */
  p1Field: string;
  p2Field: string;
  /** 卡牌 record 的点数/花色字段名（本地化）。 */
  rankField: string;
  suitField: string;
}

/**
 * 纯 CNL 牌型判定规则（三语）。源经本地 TS 引擎实测：9 类牌型严格递减序 + tiebreak
 * （KK>QQ、kicker）+ wheel(A2345) 特判 + 7 牌 best-5-of-7（List.combinations），
 * en/zh/de 三语对同一手牌判定一致，<6ms。helper 规则名/参数/字段名均为该语言标识符，
 * 不与关键词/域术语同形。卡牌字段名本地化（en rank/suit、zh 点数/花色、de wert/farbe）。
 */
export const POKER_RULES: Record<DemoLocale, PokerRule> = {
  en: {
    ruleName: 'decide', tableParam: 'table', p1Field: 'p1cards', p2Field: 'p2cards',
    rankField: 'rank', suitField: 'suit',
    source: `Module poker.showdown.

Rule cardRank given card, produce:
  Return card.rank.

Rule cardSuit given card, produce:
  Return card.suit.

Rule identity given x, produce:
  Return x.

Rule groupLen given g, produce:
  Return List.length(g).

Rule groupOrderKey given g, produce:
  Return 0 minus List.length(g) times 16 plus List.get(g, 0).

Rule concatLists given acc, g, produce:
  Return List.concat(acc, g).

Rule pushNibble given acc, rank, produce:
  Return acc times 16 plus rank.

Rule first5 given xs, produce:
  Return [List.get(xs, 0), List.get(xs, 1), List.get(xs, 2), List.get(xs, 3), List.get(xs, 4)].

Rule pad5 given xs, produce:
  Return first5(List.concat(xs, [0, 0, 0, 0, 0])).

Rule encodeScore given category, kickers, produce:
  Return List.reduce(pad5(kickers), category, pushNibble).

Rule tiebreakRanks given ranks, produce:
  Let groups be Map.values(List.groupBy(ranks, identity)).
  Let ordered be List.sortBy(groups, groupOrderKey).
  Return List.reduce(ordered, [], concatLists).

Rule classifyScore5 given cards, produce:
  Let ranks be List.map(cards, cardRank).
  Let suits be List.map(cards, cardSuit).
  Let distinctSuits be List.length(List.distinct(suits)).
  Let sortedDistinct be List.sort(List.distinct(ranks)).
  Let distinctRanks be List.length(sortedDistinct).
  Let maxGroup be List.max(List.map(Map.values(List.groupBy(ranks, identity)), groupLen)).
  Let span be List.max(ranks) minus List.min(ranks).
  Let kickers be tiebreakRanks(ranks).
  Let straightHigh be List.max(ranks).
  Let isFlush be distinctSuits equals to 1.
  Let isWheel be distinctRanks equals to 5 and List.get(sortedDistinct, 4) equals to 14 and List.get(sortedDistinct, 3) equals to 5.
  Let isStraight be distinctRanks equals to 5 and span equals to 4.
  If isWheel and isFlush:
    Return encodeScore(8, [5]).
  If isStraight and isFlush:
    Return encodeScore(8, [straightHigh]).
  If maxGroup equals to 4:
    Return encodeScore(7, kickers).
  If maxGroup equals to 3 and distinctRanks equals to 2:
    Return encodeScore(6, kickers).
  If isFlush:
    Return encodeScore(5, kickers).
  If isWheel:
    Return encodeScore(4, [5]).
  If isStraight:
    Return encodeScore(4, [straightHigh]).
  If maxGroup equals to 3:
    Return encodeScore(3, kickers).
  If maxGroup equals to 2 and distinctRanks equals to 3:
    Return encodeScore(2, kickers).
  If maxGroup equals to 2:
    Return encodeScore(1, kickers).
  Return encodeScore(0, kickers).

Rule bestScore given cards, produce:
  Let fives be List.combinations(cards, 5).
  Let scores be List.map(fives, classifyScore5).
  Return List.max(scores).

Rule decide given table, produce Text:
  Let s1 be bestScore(table.p1cards).
  Let s2 be bestScore(table.p2cards).
  If s1 greater than s2:
    Return "player1".
  If s2 greater than s1:
    Return "player2".
  Return "tie".
`,
  },
  zh: {
    ruleName: '裁决', tableParam: '台面', p1Field: '一号牌', p2Field: '二号牌',
    rankField: '点数', suitField: '花色',
    source: `模块 扑克.摊牌。

规则 取点数 给定 牌 产出：
  返回 牌.点数。

规则 取花色 给定 牌 产出：
  返回 牌.花色。

规则 本身 给定 元素 产出：
  返回 元素。

规则 组长度 给定 组 产出：
  返回 List.length(组)。

规则 组排序键 给定 组 产出：
  返回 0 减去 List.length(组) 乘以 16 加上 List.get(组, 0)。

规则 拼接 给定 累计, 组 产出：
  返回 List.concat(累计, 组)。

规则 压入 给定 累计, 点数 产出：
  返回 累计 乘以 16 加上 点数。

规则 前五 给定 序列 产出：
  返回 [List.get(序列, 0), List.get(序列, 1), List.get(序列, 2), List.get(序列, 3), List.get(序列, 4)]。

规则 补足五 给定 序列 产出：
  返回 前五(List.concat(序列, [0, 0, 0, 0, 0]))。

规则 编码分 给定 类别, 关键牌 产出：
  返回 List.reduce(补足五(关键牌), 类别, 压入)。

规则 关键牌序 给定 点数表 产出：
  令 分组 定义为 Map.values(List.groupBy(点数表, 本身))。
  令 排序后 定义为 List.sortBy(分组, 组排序键)。
  返回 List.reduce(排序后, [], 拼接)。

规则 牌型分 给定 手牌 产出：
  令 点数表 定义为 List.map(手牌, 取点数)。
  令 花色表 定义为 List.map(手牌, 取花色)。
  令 不同花色 定义为 List.length(List.distinct(花色表))。
  令 排序点数 定义为 List.sort(List.distinct(点数表))。
  令 不同点数 定义为 List.length(排序点数)。
  令 最大组 定义为 List.max(List.map(Map.values(List.groupBy(点数表, 本身)), 组长度))。
  令 跨度 定义为 List.max(点数表) 减去 List.min(点数表)。
  令 关键牌 定义为 关键牌序(点数表)。
  令 顺子高 定义为 List.max(点数表)。
  令 是同花 定义为 不同花色 等于 1。
  令 是轮子 定义为 不同点数 等于 5 并且 List.get(排序点数, 4) 等于 14 并且 List.get(排序点数, 3) 等于 5。
  令 是顺子 定义为 不同点数 等于 5 并且 跨度 等于 4。
  如果 是轮子 并且 是同花：
    返回 编码分(8, [5])。
  如果 是顺子 并且 是同花：
    返回 编码分(8, [顺子高])。
  如果 最大组 等于 4：
    返回 编码分(7, 关键牌)。
  如果 最大组 等于 3 并且 不同点数 等于 2：
    返回 编码分(6, 关键牌)。
  如果 是同花：
    返回 编码分(5, 关键牌)。
  如果 是轮子：
    返回 编码分(4, [5])。
  如果 是顺子：
    返回 编码分(4, [顺子高])。
  如果 最大组 等于 3：
    返回 编码分(3, 关键牌)。
  如果 最大组 等于 2 并且 不同点数 等于 3：
    返回 编码分(2, 关键牌)。
  如果 最大组 等于 2：
    返回 编码分(1, 关键牌)。
  返回 编码分(0, 关键牌)。

规则 最佳分 给定 手牌 产出：
  令 五张组 定义为 List.combinations(手牌, 5)。
  令 各分 定义为 List.map(五张组, 牌型分)。
  返回 List.max(各分)。

规则 裁决 给定 台面 产出 文本：
  令 一号分 定义为 最佳分(台面.一号牌)。
  令 二号分 定义为 最佳分(台面.二号牌)。
  如果 一号分 大于 二号分：
    返回 "player1"。
  如果 二号分 大于 一号分：
    返回 "player2"。
  返回 "tie"。
`,
  },
  de: {
    ruleName: 'entscheide', tableParam: 'tisch', p1Field: 'einsKarten', p2Field: 'zweiKarten',
    rankField: 'wert', suitField: 'farbe',
    source: `Modul poker.showdown.

Regel kartenWert gegeben karte liefert:
  gib zurueck karte.wert.

Regel kartenFarbe gegeben karte liefert:
  gib zurueck karte.farbe.

Regel selbst gegeben element liefert:
  gib zurueck element.

Regel gruppenLaenge gegeben gruppe liefert:
  gib zurueck List.length(gruppe).

Regel gruppenSchluessel gegeben gruppe liefert:
  gib zurueck 0 minus List.length(gruppe) mal 16 plus List.get(gruppe, 0).

Regel verbinde gegeben summe, gruppe liefert:
  gib zurueck List.concat(summe, gruppe).

Regel schiebe gegeben summe, wert liefert:
  gib zurueck summe mal 16 plus wert.

Regel ersteFuenf gegeben folge liefert:
  gib zurueck [List.get(folge, 0), List.get(folge, 1), List.get(folge, 2), List.get(folge, 3), List.get(folge, 4)].

Regel fuelleFuenf gegeben folge liefert:
  gib zurueck ersteFuenf(List.concat(folge, [0, 0, 0, 0, 0])).

Regel kodierePunkte gegeben klasse, schluessel liefert:
  gib zurueck List.reduce(fuelleFuenf(schluessel), klasse, schiebe).

Regel schluesselWerte gegeben werte liefert:
  sei gruppen gleich Map.values(List.groupBy(werte, selbst)).
  sei sortiert gleich List.sortBy(gruppen, gruppenSchluessel).
  gib zurueck List.reduce(sortiert, [], verbinde).

Regel handWert gegeben hand liefert:
  sei werte gleich List.map(hand, kartenWert).
  sei farben gleich List.map(hand, kartenFarbe).
  sei andersFarben gleich List.length(List.distinct(farben)).
  sei sortierteWerte gleich List.sort(List.distinct(werte)).
  sei andersWerte gleich List.length(sortierteWerte).
  sei groessteGruppe gleich List.max(List.map(Map.values(List.groupBy(werte, selbst)), gruppenLaenge)).
  sei spanne gleich List.max(werte) minus List.min(werte).
  sei schluessel gleich schluesselWerte(werte).
  sei reiheHoch gleich List.max(werte).
  sei istFarbe gleich andersFarben entspricht 1.
  sei istRad gleich andersWerte entspricht 5 und List.get(sortierteWerte, 4) entspricht 14 und List.get(sortierteWerte, 3) entspricht 5.
  sei istReihe gleich andersWerte entspricht 5 und spanne entspricht 4.
  wenn istRad und istFarbe:
    gib zurueck kodierePunkte(8, [5]).
  wenn istReihe und istFarbe:
    gib zurueck kodierePunkte(8, [reiheHoch]).
  wenn groessteGruppe entspricht 4:
    gib zurueck kodierePunkte(7, schluessel).
  wenn groessteGruppe entspricht 3 und andersWerte entspricht 2:
    gib zurueck kodierePunkte(6, schluessel).
  wenn istFarbe:
    gib zurueck kodierePunkte(5, schluessel).
  wenn istRad:
    gib zurueck kodierePunkte(4, [5]).
  wenn istReihe:
    gib zurueck kodierePunkte(4, [reiheHoch]).
  wenn groessteGruppe entspricht 3:
    gib zurueck kodierePunkte(3, schluessel).
  wenn groessteGruppe entspricht 2 und andersWerte entspricht 3:
    gib zurueck kodierePunkte(2, schluessel).
  wenn groessteGruppe entspricht 2:
    gib zurueck kodierePunkte(1, schluessel).
  gib zurueck kodierePunkte(0, schluessel).

Regel besteWertung gegeben hand liefert:
  sei fuenfer gleich List.combinations(hand, 5).
  sei wertungen gleich List.map(fuenfer, handWert).
  gib zurueck List.max(wertungen).

Regel entscheide gegeben tisch liefert Text:
  sei einsWert gleich besteWertung(tisch.einsKarten).
  sei zweiWert gleich besteWertung(tisch.zweiKarten).
  wenn einsWert groesser als zweiWert:
    gib zurueck "player1".
  wenn zweiWert groesser als einsWert:
    gib zurueck "player2".
  gib zurueck "tie".
`,
  },
};

export function pokerLexiconFor(loc: DemoLocale): Lexicon {
  return LEXICONS[loc];
}

/** 规则源里值得高亮的本地化领域标识符（卡牌字段名 + 顶层判定规则名）——纯 CNL 无域词汇，
 * 高亮这几个让读者一眼看到「牌/点数/花色/裁决」等扑克语义锚点。 */
export function pokerHighlightTerms(loc: DemoLocale): string[] {
  const r = POKER_RULES[loc];
  return [r.rankField, r.suitField, r.ruleName, r.tableParam];
}

/**
 * 把一手牌（Card[]）转成 CNL 规则期望的本地化字段名 record 列表。
 * en {rank,suit} / zh {点数,花色} / de {wert,farbe}——与各语言 CNL 里 `牌.点数` 取字段对齐。
 */
export function cardsForRule(loc: DemoLocale, cards: Card[]): Array<Record<string, number | string>> {
  const { rankField, suitField } = POKER_RULES[loc];
  return cards.map((c) => ({ [rankField]: c.rank, [suitField]: c.suit }));
}

/** 确定性镜像：按牌力分判赢家（与引擎一致性参照 / 兜底）。 */
export function pokerVerdictOf(p1score: number, p2score: number): PokerVerdict {
  if (p1score > p2score) return 'player1';
  if (p2score > p1score) return 'player2';
  return 'tie';
}
