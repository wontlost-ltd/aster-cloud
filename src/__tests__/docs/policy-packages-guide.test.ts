import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { docsSidebar } from '@/lib/docs/sidebar';

// ADR 0059 P2 T28：策略包操作指南。侧栏收录、三语 MDX 存在且 frontmatter 完整，
// 正文覆盖验签（aster verify）与 JRE CLI 下载（aster-cli-<版本>.jar）。
const PAGE_DIR = join(process.cwd(), 'src/app/[locale]/docs/guides/policy-packages');
const LOCALES = ['en', 'zh', 'de'] as const;

function frontmatter(src: string): Record<string, string> {
  const block = src.match(/^---\n([\s\S]*?)\n---\n/);
  if (!block) return {};
  return Object.fromEntries(
    block[1]
      .split('\n')
      .map((line) => line.match(/^(\w+):\s*"?(.*?)"?$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => [m[1], m[2]]),
  );
}

describe('policy packages guide', () => {
  it('侧栏收录 /docs/guides/policy-packages', () => {
    const hrefs = docsSidebar.flatMap((s) => s.items.map((i) => i.href as string));
    expect(hrefs).toContain('guides/policy-packages');
  });

  it('页面包装器存在', () => {
    expect(existsSync(join(PAGE_DIR, 'page.tsx'))).toBe(true);
  });

  it.each(LOCALES)('%s.mdx 有 title / description，并说明 aster verify 与 aster-cli jar', (locale) => {
    const file = join(PAGE_DIR, `${locale}.mdx`);
    expect(existsSync(file)).toBe(true);
    const src = readFileSync(file, 'utf8');
    const fm = frontmatter(src);
    expect(fm.title).toBeTruthy();
    expect(fm.description).toBeTruthy();
    expect(src).toContain('aster verify');
    expect(src).toContain('aster-cli-');
    expect(src).toContain('/api/v1/exports/keys');
  });
});
