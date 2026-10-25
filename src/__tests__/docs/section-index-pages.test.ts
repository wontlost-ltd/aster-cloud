import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// #591：面包屑为每个中间段生成链接（DocsBreadcrumb），中间目录若没有 page.tsx，
// 链接与其 RSC 预取就会 404。每个含子页的 docs 目录都必须有自己的 page（通常是重定向到首个子页）。
const DOCS_ROOT = join(process.cwd(), 'src/app/[locale]/docs');

function dirsWithChildPages(dir: string, out: string[] = []): string[] {
  const subdirs = readdirSync(dir).filter((e) => statSync(join(dir, e)).isDirectory());
  if (subdirs.some((d) => existsSync(join(dir, d, 'page.tsx')))) out.push(dir);
  for (const d of subdirs) dirsWithChildPages(join(dir, d), out);
  return out;
}

describe('docs section index pages', () => {
  it('每个含子页的 docs 目录都有 page.tsx', () => {
    const missing = dirsWithChildPages(DOCS_ROOT)
      .filter((d) => !existsSync(join(d, 'page.tsx')))
      .map((d) => d.slice(DOCS_ROOT.length) || '/');
    expect(missing).toEqual([]);
  });
});
