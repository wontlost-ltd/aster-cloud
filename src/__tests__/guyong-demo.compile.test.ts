/**
 * 「原创歌词即源码」demo（《孤勇》原创词）的**生产可验证性**契约（alias-literal + LayoutMap 范式），
 * 对三个触发词变体逐一钉死不变式，任一失败 = CI 硬失败：
 *  1. 每变体的诗体源码用《孤勇》别名词典 + 字面量宏词汇编译成功（无诊断错误）。
 *  2. 别名不变式：歌词体版 ≡ 规范关键词版（剥 origin 后结构一致 Core IR）——别名/宏只在 canonicalize 表层。
 *  3. 字面量宏真实生效：源码含触发词但**不含**展开主题句，规范版**含**主题句，运行输出 = 主题句。
 *  4. LayoutMap 不变式：toCanonical(layout) 逐字 === source；toDisplay 按序按次逐字保留全部语义内容 span；
 *     verifyContentParity 通过；语义 token 在 display 与 source 出现次数一致（防显示欺骗）。
 */
import { describe, it, expect } from 'vitest';
import {
  compile,
  evaluate,
  ZH_CN,
} from '@aster-cloud/aster-lang-ts/browser';
import { GUYONG, type GuyongVariant } from '@/config/guyong-demo';
import { toCanonical, toDisplay, verifyContentParity } from '@/lib/layout-map';

/** 按 demo content 同款方式编译某变体：直接传该变体字面量宏词汇，走 toCanonical(=source) 编译。 */
function compileVariant(v: GuyongVariant) {
  return compile(toCanonical(GUYONG.layoutFor(v)), {
    lexicon: GUYONG.lexicon,
    vocabulary: GUYONG.vocabFor(v),
  });
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

describe('guyong demo: 孤勇 · 原创歌词即源码（alias-literal + LayoutMap 范式）', () => {
  for (const v of GUYONG.variants) {
    describe(`触发词变体「${v.trigger}」`, () => {
      it('1. 诗体源码编译成功（无诊断错误）', () => {
        const r = compileVariant(v);
        const errs = (r as { parseErrors?: { message?: string }[] }).parseErrors ?? [];
        expect(r.core, `core; diags=${JSON.stringify(errs.map((e) => e.message))}`).toBeTruthy();
        expect(errs.length, JSON.stringify(errs.map((e) => e.message))).toBe(0);
        expect(r.success).toBe(true);
      });

      it('2. 别名不变式：歌词体版 ≡ 规范关键词版（结构一致 Core IR）', () => {
        const lyric = compileVariant(v);
        const canon = compile(GUYONG.canonicalFor(v), { lexicon: ZH_CN });
        const lyricErrs = (lyric as { parseErrors?: unknown[] }).parseErrors ?? [];
        const canonErrs = (canon as { parseErrors?: unknown[] }).parseErrors ?? [];
        expect(lyric.success && lyricErrs.length === 0, `lyric: ${JSON.stringify(lyricErrs)}`).toBe(true);
        expect(canon.success && canonErrs.length === 0, `canon: ${JSON.stringify(canonErrs)}`).toBe(true);
        expect(stripOrigin(lyric.core)).toEqual(stripOrigin(canon.core));
      });

      it('3. 字面量宏真实生效：源码含触发词但不含主题句，规范版含主题句，运行输出=主题句', () => {
        const source = GUYONG.sourceFor(v);
        // 源码含触发词、但**不含**展开主题句（宏未展开）。
        expect(source.includes(v.trigger), 'source contains trigger').toBe(true);
        expect(source.includes(v.themeLine), 'source must NOT hand-write the theme line').toBe(false);
        // 规范版**含**主题句（宏在此已展开）。
        expect(GUYONG.canonicalFor(v).includes(v.themeLine), 'canonical contains theme line').toBe(true);
        // 运行入口规则输出主题句（宏展开，与入参无关；入口规则无参）。
        const r = compileVariant(v);
        expect(r.core).toBeTruthy();
        const ev = evaluate(r.core!, GUYONG.entry, {});
        expect(ev.success && String(ev.value) === v.themeLine, `evaluate → theme line`).toBe(true);
      });

      it('4a. LayoutMap — toCanonical(layout) 逐字 === source（编译零漂移）', () => {
        expect(toCanonical(GUYONG.layoutFor(v))).toBe(GUYONG.sourceFor(v));
      });

      it('4b. LayoutMap — toDisplay 按序按次逐字保留全部意象内容 span', () => {
        const layout = GUYONG.layoutFor(v);
        const display = toDisplay(layout);
        const contentPieces = layout
          .filter((s): s is { text: string } => 'text' in s)
          .map((s) => s.text);
        // 成员性 + 顺序 + 次数：逐段从游标向后 indexOf，防某段被结构 span 吞掉或重排。
        let cursor = 0;
        for (const piece of contentPieces) {
          const at = display.indexOf(piece, cursor);
          expect(at, `content '${piece}' must appear in order at/after ${cursor}`).toBeGreaterThanOrEqual(cursor);
          cursor = at + piece.length;
        }
      });

      it('4c. LayoutMap — verifyContentParity 通过（结构 span 未偷塞字面量）', () => {
        const parity = verifyContentParity(GUYONG.layoutFor(v));
        expect(parity.ok, parity.reason ?? '').toBe(true);
      });

      it('4d. LayoutMap 语义诚实：领域 token 在 display 与 source 出现次数一致（防显示欺骗）', () => {
        // 独立列出领域语义 token（意象名/字面量/触发词），断言其在 toDisplay 出现次数 == 在编译源码。
        const canon = toCanonical(GUYONG.layoutFor(v));
        const display = toDisplay(GUYONG.layoutFor(v));
        const SEMANTIC_TOKENS = [
          '孤身', '入夜的城', '归途', '灯', '路', '「远方的灯」', '「脚下的路」', v.trigger,
        ];
        const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
        for (const tk of SEMANTIC_TOKENS) {
          expect(
            count(display, tk),
            `语义 token '${tk}' 在 display 出现 ${count(display, tk)} 次，编译源码 ${count(canon, tk)} 次——不一致=显示欺骗`,
          ).toBe(count(canon, tk));
        }
      });
    });
  }

  it('三变体主题句互不相同（切换真的换了输出，非固定文案）', () => {
    const lines = new Set(GUYONG.variants.map((v) => v.themeLine));
    expect(lines.size).toBe(GUYONG.variants.length);
  });
});
