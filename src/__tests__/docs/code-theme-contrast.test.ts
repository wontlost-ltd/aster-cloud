/**
 * #774 设计决策 2：文档代码高亮的每个 token 前景色，在代码块可能落的每个表面上都要 ≥ WCAG AA 4.5:1。
 * 表面直接从 @aster-cloud/tokens 的 tokens.css 解析（浅 / 暗主题各自的 --aster-bg / -subtle / -muted）；
 * rehype-pretty-code 配置了 keepBackground: false，代码块背景就是这些表面。
 * 带自身背景色的 token（如 diff 的增删行）与其背景配对核对。暗色主题核对的是 next.config.ts 实际使用的修正版主题对象。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundledThemes, codeToTokens, type BundledLanguage, type BundledTheme } from 'shiki';
import { CODE_THEME, DARK_TOKEN_PATCHES } from '@/lib/docs/code-theme';

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

/** 从 tokens.css 解析某个主题块里的三档表面色，var(--aster-color-*) 按 :root 里的色阶解析 */
function surfacesFromTokens(): { light: string[]; dark: string[] } {
  const require = createRequire(import.meta.url);
  const css = readFileSync(join(dirname(require.resolve('@aster-cloud/tokens/package.json')), 'dist/tokens.css'), 'utf8');
  const block = (selector: string) => {
    const i = css.indexOf(`${selector} {`);
    return css.slice(i, css.indexOf('}', i));
  };
  const root = block(':root');
  const scale = new Map([...root.matchAll(/(--aster-color-[\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
  const pick = (b: string) => ['--aster-bg', '--aster-bg-subtle', '--aster-bg-muted'].map((name) => {
    const raw = new RegExp(`${name}:\\s*([^;]+);`).exec(b)?.[1].trim() ?? '';
    const ref = /var\((--aster-color-[\w-]+)\)/.exec(raw)?.[1];
    return (ref ? scale.get(ref) : raw) ?? '';
  });
  return { light: pick(root), dark: pick(block('[data-theme="dark"]')) };
}

const SURFACES = surfacesFromTokens();

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
  const defaultFg = theme.colors?.['editor.foreground'];
  for (const tc of theme.tokenColors ?? []) {
    // 只声明了背景的规则：前景沿用编辑器默认前景，同样要和这块背景配对核对
    const fg = tc.settings?.foreground ?? (tc.settings?.background ? defaultFg : undefined);
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

function mdxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const full = join(dir, n);
    return statSync(full).isDirectory() ? mdxFiles(full) : n.endsWith('.mdx') ? [full] : [];
  });
}

/** 文档里所有围栏代码块（语言 + 源码），用 Shiki 实际分词核对每个渲染出来的 token */
function docsCodeBlocks(): Array<{ lang: string; code: string }> {
  const out: Array<{ lang: string; code: string }> = [];
  for (const f of mdxFiles(join(process.cwd(), 'src/app/[locale]/docs'))) {
    // 允许缩进的围栏（列表项里的代码块）：开闭围栏缩进相同，代码行去掉同样的缩进
    for (const m of readFileSync(f, 'utf8').matchAll(/^([ \t]*)```([\w-]+)[^\n]*\n([\s\S]*?)^\1```/gm)) {
      const indent = m[1].length;
      out.push({ lang: m[2], code: m[3].split('\n').map((l) => l.slice(Math.min(indent, l.length - l.trimStart().length))).join('\n') });
    }
  }
  return out;
}

describe('docs code highlighting contrast', () => {
  it('surfaces are read from the design tokens', () => {
    expect(SURFACES.light).toEqual(['#ffffff', '#fafafa', '#f4f4f5']);
    expect(SURFACES.dark).toEqual(['#09090b', '#18181b', '#27272a']);
  });

  it('every patch in code-theme.ts still matches a rule of the upstream dark theme', async () => {
    const raw = (await bundledThemes['github-dark-high-contrast']()).default as unknown as ThemeJson;
    for (const p of DARK_TOKEN_PATCHES) {
      const rule = (raw.tokenColors ?? []).find((tc) => ([] as string[]).concat(tc.scope ?? []).includes(p.scope));
      const settings = rule?.settings as { foreground?: string; background?: string } | undefined;
      if (p.foreground) expect(settings?.foreground?.toLowerCase(), p.scope).toBe(p.foreground[0]);
      if (p.background) expect(settings?.background?.toLowerCase(), p.scope).toBe(p.background[0]);
    }
  });

  it('every token Shiki renders for the docs code blocks meets 4.5:1 on every surface', async () => {
    const blocks = docsCodeBlocks();
    expect(blocks.length).toBeGreaterThan(100);
    // 每个围栏都被抽到：抽到的块数 = 文档里开围栏的行数（含缩进的）
    const fenceLines = mdxFiles(join(process.cwd(), 'src/app/[locale]/docs'))
      .reduce((n, f) => n + (readFileSync(f, 'utf8').match(/^[ \t]*```[\w-]+/gm)?.length ?? 0), 0);
    expect(blocks.length).toBe(fenceLines);
    const bad = new Set<string>();
    let tokens = 0;
    for (const { lang, code } of blocks) {
      for (const [theme, surfaces] of [[CODE_THEME.light, SURFACES.light], [CODE_THEME.dark, SURFACES.dark]] as const) {
        const { tokens: lines } = await codeToTokens(code, { lang: (lang === 'text' ? 'text' : lang) as BundledLanguage, theme: theme as BundledTheme });
        for (const t of lines.flat()) {
          if (!t.content.trim() || !t.color) continue;
          tokens += 1;
          for (const s of surfaces) {
            const surface = hex(s);
            const bg = t.bgColor ? over(hex(t.bgColor), surface) : surface;
            const f = hex(t.color);
            const r = ratio(f[3] < 1 ? over(f, bg) : f, bg);
            if (r < 4.5) bad.add(`${lang} ${t.color}${t.bgColor ? ` on ${t.bgColor}` : ''} @${s} = ${r.toFixed(2)}`);
          }
        }
      }
    }
    expect(tokens).toBeGreaterThan(1000);
    expect([...bad]).toEqual([]);
  }, 120_000);

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
