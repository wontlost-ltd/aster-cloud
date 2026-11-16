/**
 * #774：会横向 / 纵向滚动的 <pre>（className 含 overflow-*）必须 tabIndex={0}，键盘用户才能聚焦后用方向键滚动
 * （WCAG 2.1.1，axe scrollable-region-focusable）。焦点样式由 globals.css 的 pre[tabindex="0"]:focus-visible 统一提供。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const full = join(dir, n);
    if (statSync(full).isDirectory()) return n === '__tests__' ? [] : tsxFiles(full);
    return n.endsWith('.tsx') && !n.includes('.test.') ? [full] : [];
  });
}

describe('scrollable <pre> elements are keyboard-focusable', () => {
  it('every overflow <pre> has tabIndex={0}', () => {
    const missing: string[] = [];
    for (const file of tsxFiles(SRC)) {
      const rel = relative(SRC, file);
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/<pre\b[^>]*>/g)) {
        if (/overflow-/.test(m[0]) && !/tabIndex=\{0\}/.test(m[0])) {
          missing.push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('globals.css gives focused scroll regions a visible outline', () => {
    const css = readFileSync(join(SRC, 'app/globals.css'), 'utf8');
    expect(css).toMatch(/pre\[tabindex="0"\]:focus-visible/);
    expect(css).toMatch(/\[data-scroll-region\]:focus-visible/);
  });

  it('every data-scroll-region container is focusable and named', () => {
    const bad: string[] = [];
    for (const file of tsxFiles(SRC)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/<div\b[^>]*\bdata-scroll-region\b[^>]*>/g)) {
        if (!/tabIndex=\{0\}/.test(m[0]) || !/role="region"/.test(m[0]) || !/aria-label=/.test(m[0])) {
          bad.push(`${relative(SRC, file)}:${src.slice(0, m.index).split('\n').length}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
