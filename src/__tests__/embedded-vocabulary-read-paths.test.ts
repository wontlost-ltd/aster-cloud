// ADR 0060 §7.3 / 计划 T10：读版本编译输入的路径都经 execution-input（静态扫描 + 类型钉）。
// 内嵌词汇是编译输入，任何绕过 execution-input 直接取下层词汇的读取方都会少掉它，静默改变策略含义。
// - 只有白名单文件可以直接调用下层词汇加载器（冻结快照 / 作者现行词汇 / 审批冻结）；
// - 白名单里的读取方必须同时经 withEmbeddedVocabulary 合并（保存路径由 PR 8 / T9 接入）；
// - 只有白名单文件可以读 PolicyVersion.embeddedVocabulary 列，新增读取方须改白名单并在评审中说明；
// - 执行、parity、回归、日志打码、What-If 回源、Cedar / 包导出、Guard 部署都从 execution-input 取词汇。
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ExecutionVocabularyTarget, StoredVersionCompileInput } from '@/lib/execution-input';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');

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

/** 下层词汇加载器的调用（不含定义处）。 */
const LOWER_LOADER_CALL = /\b(?:loadVocabularyForExecution|loadLiveVocabularyForPolicy|loadLiveVocabularyWithOrigins|loadExecutionVocabulary|freezeVocabularyForApproval)\s*\(/;
const MERGE_CALL = /\b(?:withEmbeddedVocabulary|mergeEmbeddedVocabulary)\s*\(/;

/** 可以直接调用下层加载器的文件 → 它在哪里并入内嵌词汇。 */
const LOWER_LOADER_ALLOWLIST: Record<string, 'merges' | 'defines'> = {
  'src/lib/domain-vocabulary-snapshot.ts': 'defines',
  'src/lib/execution-input/index.ts': 'merges',
  'src/services/policy/version-manager.ts': 'merges',
  'src/services/policy/resolver-migration.ts': 'merges',
  // 保存时编译门禁与封印（loadSaveVocabulary）：并入本版本提交 / 沿用的内嵌词汇（计划 T9）
  'src/lib/policy-compile-validator.ts': 'merges',
};

/** 可以读写 embeddedVocabulary 列 / 字段的文件。 */
const COLUMN_ALLOWLIST = new Set([
  'src/db/schema.ts',
  'src/lib/policy-embedded-vocabulary.ts',
  'src/lib/execution-input/index.ts',
  'src/lib/execution-input/masked-log-input.ts',
  'src/lib/cache.ts',
  'src/lib/guard-policy-deploy.ts',
  'src/services/policy/executable-version.ts',
  'src/services/policy/version-manager.ts',
  'src/services/policy/resolver-migration.ts',
  'src/services/policy/rule-regression-runner.ts',
  'src/app/api/policies/[id]/execute/route.ts',
  'src/app/api/v1/policies/[id]/execute/route.ts',
  'src/app/api/policies/[id]/executions/[execId]/verify-parity/route.ts',
  'src/app/api/internal/policy-versions/route.ts',
  // 写入方（计划 T9）：三条保存路由按 ADR 0060 §6.5 三态解析请求字段，PUT 读活跃版本的值以沿用
  'src/app/api/policies/route.ts',
  'src/app/api/policies/[id]/route.ts',
  'src/app/api/v1/policies/[id]/versions/route.ts',
  // 编辑器与审批视图（计划 T11）：编辑页预填活跃版本的值、表单按三态提交、版本详情 / 对比展示已存文本。
  // 都不是执行 / 导出的编译输入读取方；编辑器编译与 LSP 经 useUserVocabularyRegistration 用与保存相同的
  // mergeEmbeddedVocabulary 合并（下方单独钉住）。
  'src/app/[locale]/(dashboard)/policies/[id]/edit/page.tsx',
  'src/app/[locale]/(dashboard)/policies/[id]/edit/edit-policy-content.tsx',
  'src/components/policy/policy-form/index.tsx',
  'src/components/policy/policy-form/save-request.ts',
  'src/components/policy/policy-form/side-panel.tsx',
  'src/components/policy/policy-form/use-policy-draft.ts',
  'src/components/policy/monaco-policy-editor.tsx',
  'src/hooks/useUserVocabularyRegistration.ts',
  'src/components/policy/version-detail-panel.tsx',
  'src/components/policy/version-compare-panel.tsx',
  // 模板（计划 T13）：「静夜思」模板自带内嵌词汇常量，应用时写进编辑器表单、经正常保存路径提交；不读数据库列。
  'src/data/policy-examples.ts',
  'src/data/policy-example-showcase.ts',
]);

/** 读版本编译输入的下游：必须存在、必须经 execution-input，且不得直接调用下层加载器。 */
const DOWNSTREAM: Array<[string, RegExp]> = [
  ['src/app/api/policies/[id]/execute/route.ts', /\bloadVersionExecutionVocabulary\b/],
  ['src/app/api/v1/policies/[id]/execute/route.ts', /\bloadVersionExecutionVocabulary\b/],
  ['src/app/api/policies/[id]/executions/[execId]/verify-parity/route.ts', /\bloadVersionExecutionVocabulary\b/],
  ['src/services/policy/rule-regression-runner.ts', /\bloadVersionExecutionVocabulary\b/],
  ['src/lib/execution-input/masked-log-input.ts', /\bloadVersionExecutionVocabulary\b/],
  ['src/app/api/internal/policy-versions/route.ts', /\bloadStoredVersionCompileContext\b/],
  ['src/lib/cedar-export-input.ts', /\bloadStoredVersionCompileContext\b/],
  ['src/lib/package-export-input.ts', /\bloadCedarExportInput\b/],
  ['src/lib/guard-policy-deploy.ts', /\bloadStoredVersionCompileContext\b/],
];

describe('embedded vocabulary read paths', () => {
  it('scans a non-trivial source tree', () => {
    expect(FILES.length).toBeGreaterThan(200);
  });

  it('only allowlisted files call the lower vocabulary loaders', () => {
    const callers = FILES.filter((f) => LOWER_LOADER_CALL.test(f.text)).map((f) => f.path);
    expect(callers.filter((p) => !(p in LOWER_LOADER_ALLOWLIST))).toEqual([]);
    expect(callers).toContain('src/lib/execution-input/index.ts');
  });

  it.each(Object.entries(LOWER_LOADER_ALLOWLIST).filter(([, role]) => role === 'merges'))(
    '%s merges the embedded vocabulary into what it loads',
    (p) => {
      const text = readFileSync(path.join(ROOT, p), 'utf8');
      expect(LOWER_LOADER_CALL.test(text)).toBe(true);
      expect(MERGE_CALL.test(text)).toBe(true);
    },
  );

  it('only allowlisted files touch the embeddedVocabulary column', () => {
    const readers = FILES.filter((f) => /\bembeddedVocabulary\b/.test(f.text)).map((f) => f.path);
    expect(readers.filter((p) => !COLUMN_ALLOWLIST.has(p))).toEqual([]);
    for (const p of COLUMN_ALLOWLIST) expect(existsSync(path.join(ROOT, p))).toBe(true);
  });

  it('the editor merges embedded terms the same way the save path does', () => {
    const text = readFileSync(path.join(ROOT, 'src/hooks/useUserVocabularyRegistration.ts'), 'utf8');
    expect(text).toMatch(/\bmergeEmbeddedVocabulary\s*\(/);
  });

  it.each(DOWNSTREAM)('%s reads its vocabulary through execution-input', (p, entry) => {
    expect(existsSync(path.join(ROOT, p))).toBe(true);
    const text = readFileSync(path.join(ROOT, p), 'utf8');
    expect(text).toMatch(entry);
    expect(LOWER_LOADER_CALL.test(text)).toBe(false);
  });

  it('the execution and compile targets require the embedded column (type-level pin)', () => {
    const base = { status: 'APPROVED', vocabularySnapshotIds: null, authorId: 'a', source: 's', locale: 'en-US' };
    // @ts-expect-error 漏带 embeddedVocabulary / sourceScopesJson 不能编译
    const missing: ExecutionVocabularyTarget = base;
    const complete: ExecutionVocabularyTarget = { ...base, embeddedVocabulary: null, sourceScopesJson: null };
    const stored = {
      source: 's', aliasSet: null, sourceEnvelopeSha256: null, sourceToolchainId: null, sourceScopesJson: null,
      vocabularySnapshotIds: null, status: 'APPROVED', createdBy: 'a',
    };
    // @ts-expect-error 已存版本的编译上下文同样必须带 embeddedVocabulary
    const storedMissing: StoredVersionCompileInput = stored;
    expect([missing, complete, storedMissing]).toHaveLength(3);
  });
});
