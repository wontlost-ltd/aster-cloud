/**
 * sitemap 生成器的运行时不变量。
 *
 * 生产（Cloudflare Workers）上 sitemap 每次请求都会重新执行且没有源码目录，
 * 所以文档路由必须来自打包内联的构建期索引，而不是运行时遍历文件系统。
 * 这里用「运行时 fs 不可用」的前提去校验输出仍包含全部文档页。
 */
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';

const SITE = 'https://aster-lang.cloud';

/** 测试侧独立遍历 en.mdx，作为文档路由的真实来源对照。 */
function docsSlugsOnDisk(): string[] {
  const root = resolve(process.cwd(), 'src/app/[locale]/docs');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === 'en.mdx') out.push('/docs' + dir.slice(root.length));
    }
  };
  walk(root);
  return out.sort();
}

async function loadSitemap() {
  // 模拟 Worker 运行时：任何 node:fs 读取都失败。
  vi.resetModules();
  vi.doMock('node:fs', () => {
    throw new Error('node:fs is unavailable at runtime on Workers');
  });
  const mod = await import('@/app/sitemap');
  vi.doUnmock('node:fs');
  return mod.default();
}

describe('sitemap', () => {
  it('不依赖运行时文件系统，仍为每个文档页输出 en/zh/de 三个 <loc>', async () => {
    const entries = await loadSitemap();
    const urls = new Set(entries.map((e) => e.url));
    const slugs = docsSlugsOnDisk();
    expect(slugs.length).toBeGreaterThan(0);
    for (const slug of slugs) {
      expect(urls).toContain(`${SITE}${slug}`);
      expect(urls).toContain(`${SITE}/zh${slug}`);
      expect(urls).toContain(`${SITE}/de${slug}`);
    }
  });

  it('文档条目带互指 hreflang，且不包含英文回退语种（hi）', async () => {
    const entries = await loadSitemap();
    const zhEval = entries.find((e) => e.url === `${SITE}/zh/docs/api/policies/evaluate`);
    expect(zhEval?.alternates?.languages).toEqual({
      en: `${SITE}/docs/api/policies/evaluate`,
      zh: `${SITE}/zh/docs/api/policies/evaluate`,
      de: `${SITE}/de/docs/api/policies/evaluate`,
      'x-default': `${SITE}/docs/api/policies/evaluate`,
    });
    expect(entries.some((e) => e.url.startsWith(`${SITE}/hi/docs`))).toBe(false);
  });

  it('营销页仍覆盖全部站点语种（含 hi）', async () => {
    const entries = await loadSitemap();
    const pricing = entries.find((e) => e.url === `${SITE}/pricing`);
    expect(pricing?.alternates?.languages).toHaveProperty('hi', `${SITE}/hi/pricing`);
    expect(entries.some((e) => e.url === `${SITE}/hi/pricing`)).toBe(true);
  });
});
