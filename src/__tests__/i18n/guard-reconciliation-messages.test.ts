/**
 * Guard 对账文案（ADR 0061 §3.7，计划 T7）：`guardReconciliation.*` 与 `governancePage.reconciliation.*`
 * 在 en / zh / de / hi（包内文案 ⊕ DEMO_SUPPLEMENT 合并后）键集完全一致、无空串、{占位符} 与 en 对齐；
 * 8 个 kind、3 个 severity、3 个状态、3 种解除方式各有文案（界面用动态键 `kinds.${kind}.name` 等取值，
 * 静态键扫描覆盖不到，故在此逐项钉住）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';
import { ORPHAN_KINDS, ORPHAN_SEVERITIES, ORPHAN_STATUSES } from '@/lib/guard-reconciliation/kinds';

const ROOT = path.resolve(__dirname, '../../..');
const LOCALES = ['en', 'zh', 'de', 'hi'] as const;
const PACKAGE_FILES = {
  en: 'ui-messages/en-US.json',
  zh: 'ui-messages/zh-CN.json',
  de: 'ui-messages/de-DE.json',
  hi: 'ui-messages-hi/hi-IN.json',
} as const;
const NAMESPACES = ['guardReconciliation', 'governancePage.reconciliation'] as const;

function getNested(obj: unknown, dotPath: string): unknown {
  let cur: unknown = obj;
  for (const part of dotPath.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function leaves(obj: unknown, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (obj === null || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') for (const [lk, lv] of leaves(v, key)) out.set(lk, lv);
    else out.set(key, v);
  }
  return out;
}

const merged = Object.fromEntries(
  LOCALES.map((loc) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', '@aster-cloud', PACKAGE_FILES[loc]), 'utf8'));
    return [loc, deepMergeMessages(pkg, DEMO_SUPPLEMENT[loc])];
  }),
) as Record<(typeof LOCALES)[number], unknown>;

/** ICU 顶层占位符名（plural 分支里的 # 不算）。 */
const placeholdersOf = (s: string) => new Set([...s.matchAll(/\{(\w+)[,}]/g)].map((m) => m[1]));

describe.each(NAMESPACES)('i18n %s', (ns) => {
  const en = leaves(getNested(merged.en, ns));

  it('en 命名空间存在且非空（健全检查）', () => {
    expect(en.size).toBeGreaterThan(ns === 'guardReconciliation' ? 100 : 10);
  });

  for (const loc of LOCALES) {
    it(`[${loc}] 键集与 en 完全一致、无空串、占位符与 en 对齐`, () => {
      const cur = leaves(getNested(merged[loc], ns));
      expect([...cur.keys()].sort()).toEqual([...en.keys()].sort());
      for (const [key, value] of cur) {
        expect(typeof value, `${loc}:${ns}.${key}`).toBe('string');
        expect((value as string).trim(), `${loc}:${ns}.${key}`).not.toBe('');
        expect(placeholdersOf(value as string), `${loc}:${ns}.${key}`).toEqual(placeholdersOf(en.get(key) as string));
      }
    });
  }
});

describe('guardReconciliation 动态键', () => {
  for (const loc of LOCALES) {
    it(`[${loc}] 8 个 kind 各有名称与说明；severity / 状态 / 解除方式齐全`, () => {
      const ns = getNested(merged[loc], 'guardReconciliation');
      expect(ORPHAN_KINDS).toHaveLength(8);
      for (const { kind } of ORPHAN_KINDS) {
        expect(typeof getNested(ns, `kinds.${kind}.name`), kind).toBe('string');
        expect(typeof getNested(ns, `kinds.${kind}.description`), kind).toBe('string');
      }
      for (const s of ORPHAN_SEVERITIES) expect(typeof getNested(ns, `severity.${s}`)).toBe('string');
      for (const s of ORPHAN_STATUSES) {
        expect(typeof getNested(ns, `status.${s}`)).toBe('string');
        expect(typeof getNested(ns, `empty.${s}`)).toBe('string');
      }
      for (const r of ['late_result', 'aged_out', 'acknowledged']) expect(typeof getNested(ns, `resolution.${r}`)).toBe('string');
      const gov = getNested(merged[loc], 'governancePage.reconciliation');
      for (const s of ORPHAN_SEVERITIES) expect(typeof getNested(gov, `counts.${s}`)).toBe('string');
    });
  }
});
