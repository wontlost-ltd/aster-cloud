// i18n settings.aiKeysPage 完整性扫描
//
// 动态扫描 ai-keys-content.tsx 里的 t('key') 调用，确保 en/zh/de/hi 在
// 「包内文案 ⊕ DEMO_SUPPLEMENT」合并后都含每个 key，且 {placeholder} 与 en 对齐。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';

const ROOT = path.resolve(__dirname, '../../..');
const COMPONENT = path.join(ROOT, 'src/app/[locale]/(dashboard)/settings/ai-keys/ai-keys-content.tsx');
const LOCALES = ['en', 'zh', 'de', 'hi'] as const;
// en/zh/de 在 @aster-cloud/ui-messages，hi 在 @aster-cloud/ui-messages-hi。
const PACKAGE_FILES = {
  en: 'ui-messages/en-US.json',
  zh: 'ui-messages/zh-CN.json',
  de: 'ui-messages/de-DE.json',
  hi: 'ui-messages-hi/hi-IN.json',
} as const;

function extractKeys(text: string): string[] {
  if (!/useTranslations\(\s*['"]settings\.aiKeysPage['"]\s*\)/.test(text)) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)) out.add(m[1]);
  return [...out];
}

function getNested(obj: unknown, dotPath: string): unknown {
  let cur: unknown = obj;
  for (const part of dotPath.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const keys = extractKeys(fs.readFileSync(COMPONENT, 'utf8'));

const ns = Object.fromEntries(
  LOCALES.map((loc) => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'node_modules', '@aster-cloud', PACKAGE_FILES[loc]), 'utf8'),
    );
    const merged = deepMergeMessages(pkg, DEMO_SUPPLEMENT[loc]);
    return [loc, getNested(merged, 'settings.aiKeysPage')];
  }),
) as Record<(typeof LOCALES)[number], unknown>;

const placeholdersOf = (s: string) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));

describe('i18n settings.aiKeysPage 完整性', () => {
  it('扫描到非空 key 列表（健全检查）且含 ADR 0048 新 key', () => {
    expect(keys.length).toBeGreaterThan(20);
    expect(keys).toEqual(expect.arrayContaining(['model', 'thModel', 'modelNotAvailable']));
  });

  for (const loc of LOCALES) {
    it(`[${loc}] 每个 t() key 都存在`, () => {
      const missing = keys.filter((k) => typeof getNested(ns[loc], k) !== 'string');
      expect(missing).toEqual([]);
    });
  }

  it('zh/de/hi 的 placeholder 与 en 一致', () => {
    const mismatches: string[] = [];
    for (const k of keys) {
      const en = getNested(ns.en, k);
      if (typeof en !== 'string') continue;
      const enPh = placeholdersOf(en);
      for (const loc of ['zh', 'de', 'hi'] as const) {
        const v = getNested(ns[loc], k);
        if (typeof v !== 'string') continue;
        const ph = placeholdersOf(v);
        if (enPh.size !== ph.size || [...enPh].some((p) => !ph.has(p))) mismatches.push(`[${loc}] ${k}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
