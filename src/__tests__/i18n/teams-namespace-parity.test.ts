// i18n teams namespace 完整性扫描
//
// 扫描 src/app/[locale]/(dashboard)/teams/** 和 src/components/teams/** 里
// 所有 useTranslations('teams') 上下文中的 t('key') 调用，
// 确保 en/zh/de/hi 四语在 teams namespace 下都有对应 key，且调用时传入的插值参数
// 覆盖文案里的全部占位符（缺参数时 next-intl 格式化失败，界面显示 key 路径，见 F33）。
//
// 此测试是动态扫描（避免硬编码 key 列表），只要代码新加 t() 就自动覆盖。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';

const ROOT = path.resolve(__dirname, '../../..');
const SCAN_DIRS = [
  path.join(ROOT, 'src/app/[locale]/(dashboard)/teams'),
  path.join(ROOT, 'src/components/teams'),
];
// UI 文案真相源 = @aster-cloud/ui-messages npm 包（cloud 不再手维护 messages/*）。
// 包内文件按全码 id 命名。
const MESSAGE_LOCALES = ['en', 'zh', 'de', 'hi'] as const;
const MESSAGE_FILES = {
  en: path.join(ROOT, 'node_modules', '@aster-cloud', 'ui-messages', 'en-US.json'),
  zh: path.join(ROOT, 'node_modules', '@aster-cloud', 'ui-messages', 'zh-CN.json'),
  de: path.join(ROOT, 'node_modules', '@aster-cloud', 'ui-messages', 'de-DE.json'),
  // hi 在独立的 -hi 包里（ADR 0018）。
  hi: path.join(ROOT, 'node_modules', '@aster-cloud', 'ui-messages-hi', 'hi-IN.json'),
} as const;

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile() && /\.(tsx?|jsx?)$/.test(entry.name)) out.push(p);
  }
  return out;
}

function extractTeamsKeys(text: string): string[] {
  // 仅提取 useTranslations('teams') 上下文中的 t('key')
  if (!/useTranslations\(\s*['"]teams['"]\s*\)/.test(text)) return [];
  const out = new Set<string>();
  // 简单匹配：t('key.path') 或 t("key.path")
  for (const m of text.matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)) {
    out.add(m[1]);
  }
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

/**
 * 提取 t('key', { a, b: x }) 调用及其插值参数名。只认对象字面量顶层的 `名:` 与简写名，
 * 足以覆盖本目录的写法。以下情况记为 null、不做比对：
 * - 不传第二个参数：next-intl 此时原样返回未格式化的文案（调用方自行替换占位符），不会出错；
 * - 第二个参数不是对象字面量（变量、展开等）：无法静态判断。
 * 只有「传了参数但缺了某个占位符」才会格式化失败并显示 key 路径。
 */
function extractTeamsCalls(text: string): Array<{ key: string; args: Set<string> | null }> {
  if (!/useTranslations\(\s*['"]teams['"]\s*\)/.test(text)) return [];
  const out: Array<{ key: string; args: Set<string> | null }> = [];
  for (const m of text.matchAll(/\bt\(\s*['"]([^'"]+)['"]\s*(,\s*\{([^{}]*)\})?\s*(,|\))/g)) {
    const [, key, withArgs, body] = m;
    if (!withArgs) {
      out.push({ key, args: null });
      continue;
    }
    const args = new Set<string>();
    for (const part of body.split(',')) {
      const name = part.trim().match(/^(\w+)\s*(:|$)/);
      if (name) args.add(name[1]);
    }
    out.push({ key, args });
  }
  return out;
}

const allKeys = new Set<string>();
const allCalls: Array<{ file: string; key: string; args: Set<string> | null }> = [];
for (const dir of SCAN_DIRS) {
  for (const file of walk(dir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const k of extractTeamsKeys(text)) allKeys.add(k);
    for (const c of extractTeamsCalls(text)) allCalls.push({ file: path.relative(ROOT, file), ...c });
  }
}

const messages = Object.fromEntries(
  MESSAGE_LOCALES.map((loc) => {
    const text = fs.readFileSync(MESSAGE_FILES[loc], 'utf8');
    // 与运行时一致：包内文案之上深合并本地补充层（如 teams.members.businessRoles*，ADR 0042 §2.1）
    return [loc, deepMergeMessages(JSON.parse(text), DEMO_SUPPLEMENT[loc])];
  })
) as Record<(typeof MESSAGE_LOCALES)[number], Record<string, unknown>>;

const PLACEHOLDER_RE = /\{(\w+)\}/g;
// ICU 参数名：简单占位 {name} 与 {count, plural, ...} 的参数名都算。
const ICU_ARG_RE = /\{\s*(\w+)\s*[,}]/g;
function placeholdersOf(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.matchAll(PLACEHOLDER_RE)) out.add(m[1]);
  return out;
}

describe('i18n teams namespace 完整性', () => {
  it('扫描到非空的 teams keys 列表（健全检查）', () => {
    expect(allKeys.size).toBeGreaterThan(20);
  });

  describe('每个 t() 调用的 key 必须在四语 teams namespace 下存在', () => {
    for (const loc of MESSAGE_LOCALES) {
      it(`[${loc}] all keys present and resolve to string/object`, () => {
        const teamsNs = (messages[loc] as { teams?: unknown }).teams;
        const missing: string[] = [];
        for (const k of allKeys) {
          const val = getNested(teamsNs, k);
          if (val === undefined || val === null) missing.push(k);
        }
        if (missing.length > 0) {
          throw new Error(
            `[${loc}] teams namespace 缺失 ${missing.length} 个 keys:\n  - ` +
              missing.slice(0, 30).join('\n  - ') +
              (missing.length > 30 ? `\n  ... and ${missing.length - 30} more` : '')
          );
        }
        expect(missing).toEqual([]);
      });
    }
  });

  describe('调用时传入的参数必须覆盖文案占位符（F33：缺参 → 界面显示 key 路径）', () => {
    it('扫描到带参数的调用（健全检查）', () => {
      expect(allCalls.some((c) => c.args && c.args.size > 0)).toBe(true);
    });

    for (const loc of MESSAGE_LOCALES) {
      it(`[${loc}] 每个 t() 调用都提供了文案需要的全部参数`, () => {
        const teamsNs = (messages[loc] as { teams?: unknown }).teams;
        const problems: string[] = [];
        for (const { file, key, args } of allCalls) {
          if (args === null) continue;
          const msg = getNested(teamsNs, key);
          if (typeof msg !== 'string') continue;
          const needed = new Set([...msg.matchAll(ICU_ARG_RE)].map((m) => m[1]));
          const missing = [...needed].filter((n) => !args.has(n));
          if (missing.length > 0) {
            problems.push(`${file}: t('${key}') 缺参数 {${missing.join(', ')}}，文案为 "${msg}"`);
          }
        }
        expect(problems).toEqual([]);
      });
    }
  });

  describe('placeholder 一致性（{name} / {count} / {date} 在各语必须对齐）', () => {
    it('en→zh / en→de / en→hi placeholder set 必须完全相同', () => {
      const enTeams = (messages.en as { teams: Record<string, unknown> }).teams;
      const mismatches: string[] = [];

      for (const k of allKeys) {
        const en = getNested(enTeams, k);
        if (typeof en !== 'string') continue; // 嵌套对象或数组跳过
        const enPh = placeholdersOf(en);
        for (const loc of ['zh', 'de', 'hi'] as const) {
          const v = getNested((messages[loc] as { teams: Record<string, unknown> }).teams, k);
          if (typeof v !== 'string') {
            // 对应 locale 缺失或类型错误，由上面的 test 报；这里只关心 placeholder
            continue;
          }
          const ph = placeholdersOf(v);
          if (enPh.size !== ph.size || [...enPh].some((p) => !ph.has(p))) {
            mismatches.push(
              `[${loc}] "${k}":\n  en placeholders = {${[...enPh].join(',')}}\n  ${loc} placeholders = {${[...ph].join(',')}}`
            );
          }
        }
      }

      if (mismatches.length > 0) {
        throw new Error(
          `placeholder 不一致 ${mismatches.length} 处:\n` + mismatches.slice(0, 10).join('\n\n')
        );
      }
      expect(mismatches).toEqual([]);
    });
  });
});
