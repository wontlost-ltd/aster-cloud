import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';

/**
 * 应用页面的本地化标题（F19）。生产上 admin 页标签页是英文（"License Revocation"），
 * 其余页面共用营销标题 "Aster Cloud — Replay any credit decision"。
 */
vi.mock('next-intl/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next-intl/server')>()),
  getTranslations: vi.fn(async ({ locale, namespace }: { locale: string; namespace: string }) =>
    (key: string) => `${locale}:${namespace}.${key}`,
  ),
}));

import {
  APP_TITLE_TEMPLATE,
  localizedSectionTitle,
  localizedTitle,
} from '@/lib/page-metadata';

const params = Promise.resolve({ locale: 'zh' });

describe('localizedTitle / localizedSectionTitle', () => {
  it('页面标题按请求 locale 取文案', async () => {
    expect(await localizedTitle('dashboardNav', 'policies')({ params })).toEqual({
      title: 'zh:dashboardNav.policies',
    });
  });

  it('段布局给默认标题并重新声明品牌模板', async () => {
    expect(await localizedSectionTitle('dashboardNav', 'teams')({ params })).toEqual({
      title: { default: 'zh:dashboardNav.teams', template: APP_TITLE_TEMPLATE },
    });
    expect(APP_TITLE_TEMPLATE).toBe('%s · Aster Cloud');
  });
});

describe('每个页面标题键在四语文案中都存在', () => {
  const ROOT = path.resolve(__dirname, '../../..');
  const APP = path.join(ROOT, 'src/app/[locale]/(dashboard)');
  const PKG = {
    en: 'node_modules/@aster-cloud/ui-messages/en-US.json',
    zh: 'node_modules/@aster-cloud/ui-messages/zh-CN.json',
    de: 'node_modules/@aster-cloud/ui-messages/de-DE.json',
    hi: 'node_modules/@aster-cloud/ui-messages-hi/hi-IN.json',
  } as const;

  function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      return /^(page|layout)\.tsx$/.test(e.name) ? [p] : [];
    });
  }

  const uses: Array<{ file: string; key: string }> = [];
  for (const file of walk(APP)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/localized(?:Section)?Title\(\s*'([^']+)',\s*'([^']+)'\s*\)/g)) {
      uses.push({ file: path.relative(ROOT, file), key: `${m[1]}.${m[2]}` });
    }
  }

  it('扫描到页面标题声明（健全检查）', () => {
    expect(uses.length).toBeGreaterThan(20);
  });

  it('admin 页不再写死英文静态标题', () => {
    const offenders = walk(path.join(APP, 'admin')).filter((f) =>
      /export const metadata\s*=/.test(fs.readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  for (const loc of Object.keys(PKG) as Array<keyof typeof PKG>) {
    it(`[${loc}]`, () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, PKG[loc]), 'utf8'));
      const messages = deepMergeMessages(pkg, DEMO_SUPPLEMENT[loc]);
      const missing = uses.filter(({ key }) => {
        const v = key.split('.').reduce<unknown>(
          (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
          messages,
        );
        return typeof v !== 'string' || !v.trim() || /\{/.test(v);
      });
      expect(missing).toEqual([]);
    });
  }
});
