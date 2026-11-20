// ADR 0058 §7.7 第 5 条 / 计划 T6：下游不读 layout（静态扫描）。
// layout 只给人看：执行、证据、Cedar 导出、What-If、回放、Guard 部署与版本列表都不得读取它。
// 例外（ADR 0059 修订 4 D16）：策略包导出经 src/lib/package-export-layout.ts 读取，只为把排版作为非编译载荷放进包；
// 包导出路由与编译输入模块本身仍不得直接读取（DOWNSTREAM）。
// 只有白名单里的文件可以导入 layout 存储；只有存储本身可以直接引用 PolicyVersionLayout 表。
// 新增读取方必须改这里的白名单，并在评审中说明它不在执行 / 导出路径上。
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');

/** 可以导入 `@/lib/policy-layout/store` 的文件（相对仓库根）。页面两项供 C9 / C10 的服务端读取。 */
const STORE_IMPORT_ALLOWLIST = new Set([
  'src/services/policy/version-manager.ts',
  'src/app/api/policies/route.ts',
  'src/app/api/policies/[id]/route.ts',
  'src/app/api/v1/policies/[id]/versions/route.ts',
  'src/app/[locale]/(dashboard)/policies/[id]/edit/page.tsx',
  'src/app/[locale]/(dashboard)/policies/[id]/page.tsx',
  // 修订 4 D16：包导出的唯一读取入口，只读不编译
  'src/lib/package-export-layout.ts',
]);

/** 可以直接引用 layout 表的文件：表定义与唯一的存储实现。 */
const TABLE_ALLOWLIST = new Set(['src/db/schema.ts', 'src/lib/policy-layout/store.ts']);

/** 执行、导出、评估、回放、部署路径的代表文件：必须存在（防止改名后断言落空），且不得读取 layout。 */
const DOWNSTREAM = [
  'src/app/api/policies/[id]/execute/route.ts',
  'src/app/api/v1/policies/[id]/execute/route.ts',
  'src/services/policy/cnl-executor.ts',
  'src/services/policy/executor.ts',
  'src/services/policy/executable-version.ts',
  'src/services/policy/policy-api.ts',
  'src/services/policy/resolver-migration.ts',
  'src/app/api/policies/[id]/export/cedar/route.ts',
  'src/lib/cedar-export-input.ts',
  'src/lib/cedar-export-rules.ts',
  'src/app/api/policies/[id]/export/package/route.ts',
  'src/lib/package-export-input.ts',
  'src/lib/package-node-check.ts',
  'src/app/api/policies/[id]/whatif/route.ts',
  'src/app/api/v1/policies/[id]/whatif-batches/route.ts',
  'src/services/evidence/replay-items-client.ts',
  'src/lib/evidence-export.ts',
  'src/lib/guard-policy-deploy.ts',
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/');
const FILES = sourceFiles(SRC).map((f) => ({ path: rel(f), text: readFileSync(f, 'utf8') }));

/** 任意形式的导入（静态、动态、相对路径）指向 layout 存储 */
const STORE_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:@\/lib\/|(?:\.{1,2}\/)+(?:[\w-]+\/)*)policy-layout\/store(?:\/index)?(?:\.[cm]?[jt]sx?)?['"]/;
const TABLE_REF = /\bpolicyVersionLayouts\b|"PolicyVersionLayout"/;

describe('policy layout isolation', () => {
  it('scans a non-trivial source tree', () => {
    expect(FILES.length).toBeGreaterThan(200);
  });

  it('only allowlisted files import the layout store', () => {
    const importers = FILES.filter((f) => STORE_IMPORT.test(f.text)).map((f) => f.path);
    expect(importers.filter((p) => !STORE_IMPORT_ALLOWLIST.has(p))).toEqual([]);
    // 白名单里的现有文件确实是导入方之一（白名单不是摆设）
    expect(importers).toContain('src/services/policy/version-manager.ts');
  });

  it('only the store references the PolicyVersionLayout table', () => {
    const refs = FILES.filter((f) => TABLE_REF.test(f.text)).map((f) => f.path);
    expect(refs.filter((p) => !TABLE_ALLOWLIST.has(p))).toEqual([]);
  });

  it.each(DOWNSTREAM)('%s exists and does not read layout', (p) => {
    expect(existsSync(path.join(ROOT, p))).toBe(true);
    const text = readFileSync(path.join(ROOT, p), 'utf8');
    expect(STORE_IMPORT.test(text)).toBe(false);
    expect(TABLE_REF.test(text)).toBe(false);
    expect(text).not.toMatch(/\bloadVersionLayout\b|\bloadCarryCandidate\b/);
  });

  it('the pattern catches every import form', () => {
    for (const line of [
      "import { loadVersionLayout } from '@/lib/policy-layout/store';",
      "const m = await import('@/lib/policy-layout/store');",
      "import { x } from '../../lib/policy-layout/store';",
      "export { y } from '@/lib/policy-layout/store'",
    ]) {
      expect(STORE_IMPORT.test(line)).toBe(true);
    }
    expect(STORE_IMPORT.test("import { z } from '@/lib/policy-layout/store/index';")).toBe(true);
    expect(STORE_IMPORT.test("import { z } from './policy-layout/store.ts';")).toBe(true);
    expect(STORE_IMPORT.test("import type { StoredLayout } from '@/lib/policy-layout/types';")).toBe(false);
  });

  it('policy-layout has no barrel that could re-export the store past the scan', () => {
    const barrels = FILES.filter((f) => /^src\/lib\/policy-layout\/index\.[cm]?[jt]sx?$/.test(f.path));
    expect(barrels).toEqual([]);
  });
});
