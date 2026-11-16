/**
 * #774 设计决策 2：策略编辑器（Monaco）的每个 token 颜色与行号，在浅 / 暗两套主题下都 ≥ WCAG AA 4.5:1。
 * 背景取主题里的 editor.background，以及当前行高亮（半透明叠在背景上）——光标所在行的 token 也要读得清。
 */
import { describe, expect, it } from 'vitest';
import { asterEditorTheme } from '@/lib/editor/aster-editor-theme';

type Rgb = [number, number, number];
const parse = (h: string): { rgb: Rgb; a: number } => {
  const s = h.replace('#', '');
  const n = (i: number) => parseInt(s.slice(i, i + 2), 16);
  return { rgb: [n(0), n(2), n(4)], a: s.length === 8 ? n(6) / 255 : 1 };
};
const over = (top: string, base: Rgb): Rgb => {
  const { rgb, a } = parse(top);
  return [0, 1, 2].map((i) => rgb[i] * a + base[i] * (1 - a)) as Rgb;
};
const lum = (c: Rgb) => {
  const ch = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
};
const ratio = (a: Rgb, b: Rgb) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

function failures(isDark: boolean): string[] {
  const theme = asterEditorTheme(isDark);
  const bg = parse(theme.colors['editor.background']).rgb;
  const surfaces: Array<[string, Rgb]> = [['background', bg]];
  const lineHighlight = theme.colors['editor.lineHighlightBackground'];
  if (lineHighlight) surfaces.push(['current line', over(lineHighlight, bg)]);
  const fgs: Array<[string, string | undefined]> = [
    ['editor.foreground', theme.colors['editor.foreground']],
    ['editorLineNumber.foreground', theme.colors['editorLineNumber.foreground']],
    ['editorLineNumber.activeForeground', theme.colors['editorLineNumber.activeForeground']],
    ...theme.rules.filter((r) => r.foreground).map((r) => [r.token, `#${r.foreground}`] as [string, string]),
  ];
  const out: string[] = [];
  for (const [name, fg] of fgs) {
    expect(fg, `${name} must be defined`).toBeTruthy();
    if (!fg) continue;
    for (const [surfaceName, surface] of surfaces) {
      const r = ratio(over(fg, surface), surface);
      if (r < 4.5) out.push(`${isDark ? 'dark' : 'light'} ${name} ${fg} on ${surfaceName} = ${r.toFixed(2)}:1`);
    }
  }
  return out;
}

describe('policy editor (Monaco) theme contrast', () => {
  it('every token colour and the line numbers meet 4.5:1 in the light theme', () => {
    expect(failures(false)).toEqual([]);
  });

  it('every token colour and the line numbers meet 4.5:1 in the dark theme', () => {
    expect(failures(true)).toEqual([]);
  });
});
