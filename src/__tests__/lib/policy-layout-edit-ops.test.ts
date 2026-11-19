// 编辑器的 LayoutMap 纯函数（ADR 0058 §7.4、§7.8，计划 T9）：span 编辑保持 canonical 不变，位置投影按 UTF-16。
import { describe, expect, it } from 'vitest';
import { canonicalToDisplay, toCanonical, toDisplay, type PolicyLayout } from '@aster-cloud/aster-lang-ts/layout';
import {
  identityLayout,
  layoutEditErrorCode,
  markStructural,
  offsetAt,
  offsetAtClamped,
  positionAt,
  projectCanonicalRange,
  setStructuralDisplay,
  sourceLayoutLimitExceeded,
  unmarkStructural,
} from '@/lib/policy-layout/edit-ops';

const SOURCE = '模块 静夜思。\n\n规则 吟诵 给定 月光 作为 文本，产出 文本：\n  返回 月光。\n';

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
  } catch (e) {
    return layoutEditErrorCode(e);
  }
  return null;
}

/** 固定种子的线性同余生成器，保证随机序列可复现。 */
function lcg(seed: number) {
  let s = seed >>> 0;
  return (n: number) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % n;
  };
}

describe('identityLayout', () => {
  it('整篇源码是一个内容 span', () => {
    expect(identityLayout(SOURCE)).toEqual({ v: 1, spans: [{ text: SOURCE }] });
  });
  it('空源码 → empty_range', () => {
    expect(codeOf(() => identityLayout(''))).toBe('empty_range');
  });
});

describe('操作序列保持 toCanonical === 源码', () => {
  const sequences: Array<(l: PolicyLayout) => PolicyLayout> = [
    (l) => setStructuralDisplay(markStructural(l, 2, 3, ''), 1, ''),
    (l) => {
      const a = markStructural(l, 0, 2, 'MOD');
      const b = markStructural(a, 3, 6, '');
      return unmarkStructural(setStructuralDisplay(b, 2, '《》'), 0);
    },
    (l) => {
      const a = markStructural(l, SOURCE.length - 2, SOURCE.length, '。');
      return unmarkStructural(setStructuralDisplay(a, 1, ''), 1);
    },
  ];
  it.each(sequences.map((fn, i) => [i, fn] as const))('固定序列 %i', (_i, fn) => {
    const original = identityLayout(SOURCE);
    const snapshot = JSON.stringify(original);
    const result = fn(original);
    expect(toCanonical(result)).toBe(SOURCE);
    // 不改入参
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('固定种子 200 组随机切分 / 改 display / 恢复', () => {
    const rand = lcg(20261119);
    for (let round = 0; round < 200; round++) {
      let layout = identityLayout(SOURCE);
      for (let step = 0; step < 6; step++) {
        const structural = layout.spans.flatMap((s, i) => ('text' in s ? [] : [i]));
        const op = rand(3);
        if (op === 0 || structural.length === 0) {
          const a = rand(SOURCE.length);
          const b = a + 1 + rand(Math.min(5, SOURCE.length - a));
          try {
            layout = markStructural(layout, a, b, rand(2) ? '' : '·');
          } catch (e) {
            expect(layoutEditErrorCode(e)).toBe('crosses_structural');
          }
        } else if (op === 1) {
          layout = setStructuralDisplay(layout, structural[rand(structural.length)], rand(2) ? '' : '◇');
        } else {
          layout = unmarkStructural(layout, structural[rand(structural.length)]);
        }
        expect(toCanonical(layout)).toBe(SOURCE);
      }
    }
  });
});

describe('markStructural', () => {
  it('切成至多三段', () => {
    expect(markStructural(identityLayout('abcde'), 1, 3, 'X').spans).toEqual([
      { text: 'a' },
      { canonical: 'bc', display: 'X' },
      { text: 'de' },
    ]);
    expect(markStructural(identityLayout('abc'), 0, 3, '').spans).toEqual([{ canonical: 'abc', display: '' }]);
  });
  it('跨两个内容 span（中间隔着结构 span）→ crosses_structural', () => {
    const l = markStructural(identityLayout('abcdef'), 2, 4, '');
    expect(codeOf(() => markStructural(l, 1, 5, ''))).toBe('crosses_structural');
    expect(codeOf(() => markStructural(l, 2, 3, ''))).toBe('crosses_structural');
  });
  it('端点在 😀 中间 → splits_surrogate', () => {
    const l = identityLayout('a😀b');
    expect(codeOf(() => markStructural(l, 2, 4, ''))).toBe('splits_surrogate');
    expect(codeOf(() => markStructural(l, 0, 2, ''))).toBe('splits_surrogate');
    expect(markStructural(l, 1, 3, '🙂').spans[1]).toEqual({ canonical: '😀', display: '🙂' });
  });
  it('空区间 → empty_range；越界 → out_of_range', () => {
    const l = identityLayout('abc');
    expect(codeOf(() => markStructural(l, 1, 1, ''))).toBe('empty_range');
    expect(codeOf(() => markStructural(l, 2, 4, ''))).toBe('out_of_range');
    expect(codeOf(() => markStructural(l, -1, 1, ''))).toBe('out_of_range');
    expect(codeOf(() => markStructural(l, 2, 1, ''))).toBe('out_of_range');
    expect(codeOf(() => markStructural(l, 0.5, 1, ''))).toBe('out_of_range');
  });
});

describe('unmarkStructural / setStructuralDisplay', () => {
  it('恢复后与相邻内容 span 合并（span 数减 2）', () => {
    const l = markStructural(identityLayout('abcde'), 1, 3, 'X');
    expect(l.spans).toHaveLength(3);
    const back = unmarkStructural(l, 1);
    expect(back.spans).toEqual([{ text: 'abcde' }]);
  });
  it('不是结构 span 的下标 → out_of_range', () => {
    const l = markStructural(identityLayout('abcde'), 1, 3, 'X');
    expect(codeOf(() => unmarkStructural(l, 0))).toBe('out_of_range');
    expect(codeOf(() => setStructuralDisplay(l, 5, ''))).toBe('out_of_range');
  });
  it('改 display 只改 display', () => {
    const l = setStructuralDisplay(markStructural(identityLayout('abcde'), 1, 3, 'X'), 1, '');
    expect(toDisplay(l)).toBe('ade');
    expect(toCanonical(l)).toBe('abcde');
  });
});

describe('offsetAt / positionAt', () => {
  it('第 3 行偏移含前两行长度', () => {
    expect(offsetAt('ab\ncde\nf', 3, 1)).toBe(7);
    expect(offsetAt('ab\ncde\nf', 2, 4)).toBe(6);
  });
  it('前一行含 😀 时偏移比码点多 1', () => {
    const text = 'a😀\nb';
    expect(offsetAt(text, 2, 1)).toBe(4);
    expect([...'a😀\n'].length).toBe(3);
  });
  it('\\r\\n：第 2 行第 1 列在 \\r\\n 之后，\\r 属于上一行末尾', () => {
    const text = 'ab\r\ncd';
    expect(offsetAt(text, 2, 1)).toBe(4);
    expect(positionAt(text, 2)).toEqual({ line: 1, column: 3 });
    expect(positionAt(text, 4)).toEqual({ line: 2, column: 1 });
  });
  it('二者互逆', () => {
    const text = '模块 a。\r\n😀 x\n\ny';
    for (let o = 0; o <= text.length; o++) {
      const p = positionAt(text, o);
      expect(offsetAt(text, p.line, p.column)).toBe(o);
    }
  });
  it('offsetAtClamped 把越界行列夹到最近的合法位置，合法输入与 offsetAt 相同', () => {
    expect(offsetAtClamped('ab\ncd', 1, 99)).toBe(2);
    expect(offsetAtClamped('ab\ncd', 9, 1)).toBe(3);
    expect(offsetAtClamped('ab\ncd', 0, 0)).toBe(0);
    expect(offsetAtClamped('ab\ncd', 2, 2)).toBe(offsetAt('ab\ncd', 2, 2));
  });
  it('越界 → out_of_range', () => {
    expect(codeOf(() => offsetAt('ab', 2, 1))).toBe('out_of_range');
    expect(codeOf(() => offsetAt('ab', 1, 4))).toBe('out_of_range');
    expect(codeOf(() => positionAt('ab', 3))).toBe('out_of_range');
  });
});

describe('projectCanonicalRange', () => {
  // canonical: "若 x 则 y" ；「若 」与「则 」为结构 span
  const layout: PolicyLayout = {
    v: 1,
    spans: [
      { canonical: '若 ', display: 'IF ' },
      { text: 'x ' },
      { canonical: '则 ', display: '' },
      { text: 'y' },
    ],
  };
  it('落在内容 span 内的区间长度不变', () => {
    expect(projectCanonicalRange(layout, 2, 3)).toEqual({ start: 3, end: 4 });
    expect(projectCanonicalRange(layout, 6, 7)).toEqual({ start: 5, end: 6 });
  });
  it('落在结构 span 内（含部分重叠）扩到整段 display', () => {
    expect(projectCanonicalRange(layout, 1, 2)).toEqual({ start: 0, end: 3 });
    expect(projectCanonicalRange(layout, 0, 3)).toEqual({ start: 0, end: 4 });
  });
  it('结构 span display 为空时返回零宽点', () => {
    expect(projectCanonicalRange(layout, 4, 6)).toEqual({ start: 5, end: 5 });
  });
  it('区间以结构 span 结尾时包含其 display', () => {
    expect(projectCanonicalRange(layout, 2, 4)).toEqual({ start: 3, end: 5 });
    expect(projectCanonicalRange(layout, 0, 2)).toEqual({ start: 0, end: 3 });
  });
  it('start === end 返回 canonicalToDisplay(start).start 的点', () => {
    for (let o = 0; o <= toCanonical(layout).length; o++) {
      const p = canonicalToDisplay(layout, o).start;
      expect(projectCanonicalRange(layout, o, o)).toEqual({ start: p, end: p });
    }
  });
  it('越界或反向 → out_of_range', () => {
    expect(codeOf(() => projectCanonicalRange(layout, 0, 99))).toBe('out_of_range');
    expect(codeOf(() => projectCanonicalRange(layout, 3, 2))).toBe('out_of_range');
  });
});

describe('sourceLayoutLimitExceeded', () => {
  it('UTF-8 字节与行数按包的上限', () => {
    expect(sourceLayoutLimitExceeded('a'.repeat(12288))).toBeNull();
    expect(sourceLayoutLimitExceeded('a'.repeat(12289))).toEqual({ limit: 'sourceBytes', actual: 12289 });
    expect(sourceLayoutLimitExceeded('字'.repeat(4097))).toEqual({ limit: 'sourceBytes', actual: 12291 });
    expect(sourceLayoutLimitExceeded('a\n'.repeat(200))).toBeNull();
    expect(sourceLayoutLimitExceeded('a\r\n'.repeat(200) + 'b')).toEqual({ limit: 'sourceLines', actual: 201 });
  });
});
