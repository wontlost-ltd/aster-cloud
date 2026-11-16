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
  it('every #anchor link points at a heading on the same page', () => {
    const broken: string[] = [];
    for (const file of mdxFiles(DOCS)) {
      // 去掉代码块，避免把示例里的 # 当成链接 / 标题
      const src = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
      const ids = new Set(Array.from(src.matchAll(/^#{1,6}\s+(.+?)\s*$/gm), (m) => slug(m[1])));
      for (const m of src.matchAll(/\]\(#([^)\s]+)\)/g)) {
        const target = decodeURIComponent(m[1]);
        if (!ids.has(target)) broken.push(`${relative(DOCS, file)} → #${target}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
