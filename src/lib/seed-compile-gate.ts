/**
 * 种子脚本的编译门禁。
 *
 * 直接 `insert(policyVersions)` 的种子脚本绕过了 REST 保存门（那里才会调服务端编译 + 类型检查）。
 * 这里用与编辑器同一份 aster-lang-ts 做编译 + 类型检查（两侧检查器已按 parity 门对齐），
 * 任一 error 级诊断都让种子脚本在写库前失败，避免清库重建后把类型不正确的策略再灌一遍。
 */
export type SeedLocale = 'en-US' | 'zh-CN' | 'de-DE';

type Engine = typeof import('@aster-cloud/aster-lang-ts/browser');

// 包的 ./browser 子路径只有 ESM 导出；种子脚本经 tsx 以 CJS 运行，静态 import 会被 require 条件拒绝，
// 故用动态 import（CJS 与 ESM 都可用），并缓存一次。
let enginePromise: Promise<Engine> | null = null;
function engine(): Promise<Engine> {
  enginePromise ??= import('@aster-cloud/aster-lang-ts/browser');
  return enginePromise;
}

export interface SeedCompileProblem {
  readonly code: string;
  readonly message: string;
  readonly line?: number;
}

/** 返回 error 级问题列表；空数组表示源码可编译且类型检查通过。 */
export async function seedCompileProblems(source: string, locale: SeedLocale): Promise<SeedCompileProblem[]> {
  const { compileAndTypecheck, EN_US, ZH_CN, DE_DE } = await engine();
  const lexicons = { 'en-US': EN_US, 'zh-CN': ZH_CN, 'de-DE': DE_DE } as const;
  const result = compileAndTypecheck(source, { lexicon: lexicons[locale] });
  const problems: SeedCompileProblem[] = [];
  for (const err of result.parseErrors ?? []) {
    const e = err as { message?: string; span?: { start?: { line?: number } } } | string;
    problems.push(
      typeof e === 'string'
        ? { code: 'E000', message: e }
        : { code: 'E000', message: e.message ?? String(err), line: e.span?.start?.line },
    );
  }
  for (const err of result.loweringErrors ?? []) problems.push({ code: 'E000', message: String(err) });
  // 名称解析错误（ADR 0051 E8xx）只出现在 resolutionDiagnostics，且此时引擎不做类型检查。
  for (const d of [...(result.resolutionDiagnostics ?? []), ...(result.typeErrors ?? [])]) {
    if (d.severity === 'error') problems.push({ code: String(d.code), message: d.message, line: d.span?.start.line });
  }
  return problems;
}

/** 种子写库前调用：有 error 级问题则抛错并列出全部诊断。 */
export async function assertSeedCompiles(source: string, locale: SeedLocale, label: string): Promise<void> {
  const problems = await seedCompileProblems(source, locale);
  if (problems.length === 0) return;
  const lines = problems.map((p) => `  ${p.code}${p.line ? ` L${p.line}` : ''}: ${p.message}`).join('\n');
  throw new Error(`[seed] 策略 "${label}" 未通过编译/类型检查，拒绝写库：\n${lines}`);
}
