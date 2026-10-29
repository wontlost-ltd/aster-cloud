/**
 * 「源码即诗」demo 的**生产可验证性**契约（四语：en/zh/de/hi），三种范式，每种钉死不变式，
 * 任一失败 = CI 硬失败：
 *
 * **computed 范式**（en）——一首连贯递归谣曲，无括号 apply 递归织段。诗读连贯，但每次调用、
 *   每次拼接都是引擎真求值：
 *   1. 诗体源码用诗词别名词典编译成功（无诊断错误）。
 *   2. 入口 rule 代入每个样本 input 跑出的整首诗逐字一致（计算交织的诗）。
 *   3. 诗体方言版 ≡ 规范关键词版（剥 origin 后结构一致 Core IR）——证明别名只在表层。
 *   4. 诗句仍是代码：源码含 List 求和或无括号递归调用（en）等真计算结构。
 *
 * **alias-literal 范式**（zh《静夜思》李白 / hi《गीतांजलि #35》泰戈尔）——整首诗按**原词序**即
 *   源码：关键词别名把领字变结构关键词，**字面量宏**（IdentifierKind.LITERAL）把末词展开成字符串：
 *   2. 入口 rule 每个样本 input 输出恒为名句（宏展开，与入参无关；入口 rule 可无 given 参数）。
 *   4. 字面量宏真实生效：源码含触发词但不含展开内容，规范版含展开内容，运行输出=字面量内容。
 *
 * **decision 范式**（de《Du bist mein, ich bin dein》）——中世纪情诗即一条裁决规则：四个布尔
 *   前提当输入，引擎 let 绑定推导再 wenn/sonst 真判定。不变式：
 *   1. 编译成功；3. 诗体版 ≡ 规范版 Core IR。
 *   4. 全前提为真 → verdictAll；翻任一前提 → verdictElse（引擎真判定，翻转随前提）。
 */
import { describe, it, expect } from 'vitest';
import { compile, evaluate, EN_US, ZH_CN, DE_DE, HI_IN } from '@aster-cloud/aster-lang-ts/browser';
import { POEMS, type PoemLocale, type PoemConfig } from '@/config/poem-demo';
import { toCanonical, toDisplay, verifyContentParity } from '@/lib/layout-map';

const BASE: Record<PoemLocale, typeof ZH_CN> = { en: EN_US, zh: ZH_CN, de: DE_DE, hi: HI_IN };
const LOCALES: PoemLocale[] = ['en', 'zh', 'de', 'hi'];

/** 按 demo content 同款方式编译：带 vocab（alias-literal）时把字面量宏词汇表作为编译词汇传入（ADR 0051）。 */
function compileWithVocab(poem: PoemConfig, source: string) {
  return compile(source, { lexicon: poem.lexicon, ...(poem.vocab ? { vocabulary: poem.vocab } : {}) });
}

function compilePoem(poem: PoemConfig) {
  return compileWithVocab(poem, poem.source);
}

/** 剥离 origin/span（位置元数据；结构比较口径）。 */
function stripOrigin(o: unknown): unknown {
  if (Array.isArray(o)) return o.map(stripOrigin);
  if (o && typeof o === 'object') {
    const r: Record<string, unknown> = {};
    for (const k of Object.keys(o)) {
      if (k === 'origin' || k === 'span') continue;
      r[k] = stripOrigin((o as Record<string, unknown>)[k]);
    }
    return r;
  }
  return o;
}

describe('poem demo: source-as-poem across three paradigms', () => {
  for (const loc of LOCALES) {
    const poem = POEMS[loc];

    it(`${loc} (${poem.title}): 诗体源码编译成功（无诊断错误）`, () => {
      const r = compilePoem(poem);
      const errs = (r as { parseErrors?: { message?: string }[] }).parseErrors ?? [];
      expect(r.core, `[${loc}] core; diags=${JSON.stringify(errs.map((e) => e.message))}`).toBeTruthy();
      expect(errs.length, JSON.stringify(errs.map((e) => e.message))).toBe(0);
    });

    it(`${loc} (${poem.title}): 别名不变式 — 诗体版 ≡ 规范关键词版（结构一致 Core IR）`, () => {
      const poemR = compilePoem(poem);
      const canonR = compile(poem.canonical, { lexicon: BASE[loc] });
      const poemErrs = (poemR as { parseErrors?: unknown[] }).parseErrors ?? [];
      const canonErrs = (canonR as { parseErrors?: unknown[] }).parseErrors ?? [];
      expect(poemR.success && poemErrs.length === 0, `[${loc}] poem: ${JSON.stringify(poemErrs)}`).toBe(true);
      expect(canonR.success && canonErrs.length === 0, `[${loc}] canonical: ${JSON.stringify(canonErrs)}`).toBe(true);
      expect(stripOrigin(poemR.core)).toEqual(stripOrigin(canonR.core));
    });

    if (poem.paradigm === 'decision') {
      // ── decision 范式（de《Du bist mein》）──────────────────────────────
      const spec = poem.decision!;
      const allTrue = () => Object.fromEntries(spec.toggles.map((tg) => [tg.name, true]));

      it(`${loc} (${poem.title}): 全前提为真 → 裁决 verdictAll`, () => {
        const r = compilePoem(poem);
        expect(r.core).toBeTruthy();
        const ev = evaluate(r.core!, poem.entry, allTrue());
        expect(ev.success, `[${loc}] eval: ${ev.error ?? ''}`).toBe(true);
        expect(String(ev.value), `[${loc}] verdictAll`).toBe(spec.verdictAll);
      });

      it(`${loc} (${poem.title}): 翻任一前提 → 裁决翻成 verdictElse（引擎真判定，非查表）`, () => {
        const r = compilePoem(poem);
        expect(r.core).toBeTruthy();
        // 逐个把某个前提置假，其余为真——每种都应翻成 verdictElse。
        for (const flip of spec.toggles) {
          const inputs = allTrue();
          inputs[flip.name] = false;
          const ev = evaluate(r.core!, poem.entry, inputs);
          expect(ev.success, `[${loc}] flip ${flip.name} eval: ${ev.error ?? ''}`).toBe(true);
          expect(String(ev.value), `[${loc}] flipping '${flip.name}' must give verdictElse`).toBe(spec.verdictElse);
        }
        // 且两种裁决确实不同（否则“翻转”无意义）。
        expect(spec.verdictAll).not.toBe(spec.verdictElse);
      });

      it(`${loc} (${poem.title}): 推导链自洽 — derived 中间值只引用合法 toggle 前提`, () => {
        // “非回声”的真正证据是上一条（翻前提裁决会变）。这里补充推导链自洽性：每个中间值
        // 展示所依赖的 from 前提名都必须是已声明的 toggle，否则前端镜像复算会引用不存在的输入。
        const toggleNames = new Set(spec.toggles.map((tg) => tg.name));
        for (const d of spec.derived) {
          for (const from of d.from) {
            expect(toggleNames.has(from), `[${loc}] derived '${d.name}' references unknown toggle '${from}'`).toBe(true);
          }
        }
      });
    } else {
      // ── computed / alias-literal 范式（用 samples）─────────────────────
      it(`${loc} (${poem.title}): 每个样本代入后的输出逐字一致`, () => {
        const r = compilePoem(poem);
        expect(r.core).toBeTruthy();
        // computed 范式必须有 param（按 input 计算）；alias-literal 范式入口 rule 可无参
        // （输出与入参无关，页面 runOnce 传 {}），此时用空参对象逐样本验证恒定输出。
        if (poem.paradigm !== 'alias-literal') {
          expect(poem.param, `[${loc}] computed poem has a param`).toBeTruthy();
        }
        for (const s of poem.samples ?? []) {
          const args = poem.param ? { [poem.param]: s.input } : {};
          const ev = evaluate(r.core!, poem.entry, args);
          expect(ev.success, `[${loc}] ${poem.entry}(${s.input}) eval: ${ev.error ?? ''}`).toBe(true);
          expect(String(ev.value), `[${loc}] ${poem.entry}(${s.input})`).toBe(s.woven);
        }
      });

      it(`${loc} (${poem.title}): 诗句仍是真代码（按范式验证计算/字面量宏）`, () => {
        const samples = poem.samples ?? [];
        if (poem.paradigm === 'alias-literal') {
          // 字面量宏范式：所有 input 输出恒为诗名（宏展开，与入参无关）。
          const wovens = new Set(samples.map((s) => s.woven));
          expect(wovens.size, `[${loc}] literal-macro output is constant`).toBe(1);
          // vocab contract：compile 用 lexicon.id 作 locale 查词汇表 → vocab.id/locale 都须 = lexicon.id。
          expect(poem.vocab, `[${loc}] alias-literal poem has a vocab`).toBeTruthy();
          expect(poem.vocab!.id, `[${loc}] vocab.id === lexicon.id`).toBe(poem.lexicon.id);
          expect(poem.vocab!.locale, `[${loc}] vocab.locale === lexicon.id`).toBe(poem.lexicon.id);
          // 字面量宏真实生效，且不是绕过宏手写字面量：
          const literal = poem.vocab?.literals?.[0];
          expect(literal, `[${loc}] has a literal-macro mapping`).toBeTruthy();
          expect(poem.source.includes(literal!.localized), `[${loc}] source contains localized trigger`).toBe(true);
          expect(poem.source.includes(literal!.canonical), `[${loc}] source must NOT hand-write the expanded literal`).toBe(false);
          expect(poem.canonical.includes(literal!.canonical), `[${loc}] canonical contains expanded literal`).toBe(true);
          const r = compilePoem(poem);
          expect(r.core, `[${loc}] compiles`).toBeTruthy();
          const args = poem.param ? { [poem.param]: samples[0]!.input } : {};
          const ev = evaluate(r.core!, poem.entry, args);
          expect(ev.success && String(ev.value) === literal!.canonical, `[${loc}] macro expands to the literal content at runtime`).toBe(true);
        } else {
          // computed 范式：三个样本输出互不相同——结果随入参由计算决定，不是固定整首诗。
          const wovens = new Set(samples.map((s) => s.woven));
          expect(wovens.size, `[${loc}] distinct woven per input`).toBe(samples.length);
          const hasListSum = poem.source.includes('List.range') && poem.source.includes('List.sum');
          const aliasApply = (poem.lexicon as { aliases?: Record<string, string[]> }).aliases?.['APPLY']?.[0] ?? '';
          const hasRecursiveCall = aliasApply.length > 0 && poem.source.includes(aliasApply);
          expect(hasListSum || hasRecursiveCall, `[${loc}] has List sum or paren-free recursive call`).toBe(true);
        }
      });
    }

    // ── LayoutMap 不变式（携 layout 的诗才验；zh《静夜思》）─────────────────
    // 显示/编译解耦的核心契约：页面**显示** toDisplay（无空格工整原诗），**编译**走 toCanonical，
    // 而 toCanonical 必须逐字 === poem.source（编译行为零漂移，仅显示层变化）。
    if (poem.layout) {
      it(`${loc} (${poem.title}): LayoutMap — toCanonical(layout) 逐字 === poem.source（编译零漂移）`, () => {
        expect(toCanonical(poem.layout!)).toBe(poem.source);
      });

      it(`${loc} (${poem.title}): LayoutMap — toDisplay 隐去关键词间空格（显示为无空格原诗）`, () => {
        const display = toDisplay(poem.layout!);
        // 显示层不含「关键词 内容」之间用于满足语法的空格；也不含缩进空格（结构 span 用换行标点替代）。
        expect(display.includes(' '), `[${loc}] display must have no keyword-space`).toBe(false);
        // 且显示层仍逐字保留全部诗词内容 span（内容不被隐藏）。
        const contentPieces = poem.layout!
          .filter((s): s is { text: string } => 'text' in s)
          .map((s) => s.text);
        for (const piece of contentPieces) {
          expect(display.includes(piece), `[${loc}] display retains content '${piece}'`).toBe(true);
        }
      });

      it(`${loc} (${poem.title}): LayoutMap — verifyContentParity 通过（结构 span 未偷塞字面量）`, () => {
        const v = verifyContentParity(poem.layout!);
        expect(v.ok, `[${loc}] ${v.reason ?? ''}`).toBe(true);
      });

      it(`${loc} (${poem.title}): LayoutMap — 用 toCanonical 编译与用 source 编译得同一 Core IR`, () => {
        // 证明「走 layout 的 canonical 源码」与「直接用 source」编译结果结构一致（因二者逐字相等）。
        const viaLayout = compileWithVocab(poem, toCanonical(poem.layout!));
        const viaSource = compilePoem(poem);
        expect(viaLayout.core, `[${loc}] layout compiles`).toBeTruthy();
        expect(stripOrigin(viaLayout.core)).toEqual(stripOrigin(viaSource.core));
      });
    }
  }
});
