/**
 * #774：文档 MDX 里的页内锚点（`[文字](#slug)`）必须指向本页真实存在的标题 id。
 * 标题 id 由 rehype-slug（github-slugger）按标题文字生成：中文 / 德文标题生成的是本地化 slug，
 * 照抄英文版的 `#status-values` 在 zh / de 页面上会失效（审计发现 zh 两处）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const DOCS = join(process.cwd(), 'src/app/[locale]/docs');

function mdxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const full = join(dir, n);
    return statSync(full).isDirectory() ? mdxFiles(full) : n.endsWith('.mdx') ? [full] : [];
  });
}

/** 与 github-slugger 一致：小写、去掉标点（保留字母 / 数字 / 连字符 / 下划线 / 空格），空格转连字符 */
function slug(heading: string): string {
  return heading
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
}

describe('docs MDX in-page anchors', () => {
  it('slugs headings the way rehype-slug does', () => {
    expect(slug('Get Anomaly Detail')).toBe('get-anomaly-detail');
    expect(slug('获取异常详情')).toBe('获取异常详情');
    expect(slug('HTTP 状态码')).toBe('http-状态码');
    expect(slug('Anomalie-Status aktualisieren')).toBe('anomalie-status-aktualisieren');
    expect(slug('`policyModule` (string)')).toBe('policymodule-string');
  });

  it('every #anchor link points at a heading on the same page', () => {
    const broken: string[] = [];
    for (const file of mdxFiles(DOCS)) {
      // 去掉代码块，避免把示例里的 # 当成链接 / 标题
      const src = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
      // 同名标题按 github-slugger 规则追加 -1、-2…
      const ids = new Set<string>();
      const seen = new Map<string, number>();
      for (const m of src.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) {
        const base = slug(m[1]);
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        ids.add(n === 0 ? base : `${base}-${n}`);
      }
      for (const m of src.matchAll(/\]\(#([^)\s]+)\)/g)) {
        const target = decodeURIComponent(m[1]);
        if (!ids.has(target)) broken.push(`${relative(DOCS, file)} → #${target}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
