/**
 * #774 设计决策 2：文档代码高亮的每个 token 前景色，在代码块可能落的每个表面上都要 ≥ WCAG AA 4.5:1。
 * 表面取自 @aster-cloud/tokens（浅：bg #fff / bg-subtle zinc-50 / bg-muted zinc-100；暗：zinc-950 / 900 / 800）；
 * rehype-pretty-code 配置了 keepBackground: false，代码块背景就是这些表面。
 * 带自身背景色的 token（如 diff 的增删行）与其背景配对核对。暗色主题核对的是 next.config.ts 实际使用的修正版主题对象。
 */
import { describe, expect, it } from 'vitest';
import { bundledThemes } from 'shiki';
import { CODE_THEME } from '@/lib/docs/code-theme';

type Rgba = [number, number, number, number];
const hex = (h: string): Rgba => {
  let s = h.replace('#', '');
  if (s.length === 3 || s.length === 4) s = s.replace(/./g, '$&$&');
  const n = (i: number) => parseInt(s.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), s.length === 8 ? n(6) / 255 : 1];
};
const lin = (c: number) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const lum = (c: Rgba) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const over = (f: Rgba, b: Rgba): Rgba => [0, 1, 2].map((i) => f[i] * f[3] + b[i] * (1 - f[3])).concat(1) as Rgba;
const ratio = (a: Rgba, b: Rgba) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const SURFACES = {
  light: ['#ffffff', '#fafafa', '#f4f4f5'],
  dark: ['#09090b', '#18181b', '#27272a'],
};

interface ThemeJson {
  colors?: Record<string, string>;
  tokenColors?: Array<{ scope?: string | string[]; settings?: { foreground?: string; background?: string } }>;
}

async function load(theme: string | ThemeJson): Promise<{ name: string; json: ThemeJson }> {
  if (typeof theme !== 'string') return { name: (theme as { name?: string }).name ?? 'custom', json: theme };
  return { name: theme, json: (await bundledThemes[theme as keyof typeof bundledThemes]()).default as unknown as ThemeJson };
}

async function failures(themeRef: string | ThemeJson, surfaces: string[]): Promise<string[]> {
  const { name, json: theme } = await load(themeRef);
  const out: string[] = [];
  const pairs: Array<[string, string]> = [];
  if (theme.colors?.['editor.foreground']) for (const s of surfaces) pairs.push([theme.colors['editor.foreground'], s]);
  for (const tc of theme.tokenColors ?? []) {
    const fg = tc.settings?.foreground;
    if (!fg) continue;
    if (tc.settings?.background) for (const s of surfaces) pairs.push([fg, `${tc.settings.background}@${s}`]);
    else for (const s of surfaces) pairs.push([fg, s]);
  }
  for (const [fg, bgSpec] of pairs) {
    const [tint, base] = bgSpec.includes('@') ? bgSpec.split('@') : [null, bgSpec];
    const surface = hex(base);
    const bg = tint ? over(hex(tint), surface) : surface;
    const f = hex(fg);
    const r = ratio(f[3] < 1 ? over(f, bg) : f, bg);
    if (r < 4.5) out.push(`${name}: ${fg} on ${bgSpec} = ${r.toFixed(2)}:1`);
  }
  return out;
}

describe('docs code highlighting contrast', () => {
  it('uses the high-contrast GitHub themes (dark one with patched diff colours)', () => {
    expect(CODE_THEME.light).toBe('github-light-high-contrast');
    expect(CODE_THEME.dark.name).toBe('github-dark-high-contrast-aa');
  });

  it('every light-theme token meets 4.5:1 on every light surface', async () => {
    expect(await failures(CODE_THEME.light, SURFACES.light)).toEqual([]);
  });

  it('every dark-theme token meets 4.5:1 on every dark surface', async () => {
    expect(await failures(CODE_THEME.dark as unknown as ThemeJson, SURFACES.dark)).toEqual([]);
  });

  it('the previous themes would fail (guards the check itself)', async () => {
    expect((await failures('github-light', SURFACES.light)).length).toBeGreaterThan(0);
    expect((await failures('github-dark', SURFACES.dark)).length).toBeGreaterThan(0);
  });

  it('the unpatched dark high-contrast theme would fail on its diff colours (guards the patch)', async () => {
    const raw = await failures('github-dark-high-contrast', SURFACES.dark);
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.every((f) => /@/.test(f))).toBe(true);
  });
});
