/**
 * 从策略版本源码取出规则经 `@control("…")`（ADR 0039 §3）挂接的控制键（#739）。
 *
 * 为什么读源码而不是 Core IR 或执行记录：cloud 的 PolicyVersion 只存源码（无 IR 列），
 * 保存时的编译结果不落库；Execution.controls 只在策略被执行过时才有，且只反映被执行的那条规则。
 * 影响分析要回答「哪些策略的哪些版本引用了这个控制项」，源码是编译器读的同一份输入，也是唯一覆盖
 * 全部版本与全部规则的来源。
 *
 * 取值走 aster-lang-ts `parseSource` 的 AST 注解（与编译器同源：同一 lexicon、同一份版本别名、
 * 同一套字符串转义解码），不自写扫描器——自写扫描会把 `@control("GDPR:ART6")` 读成原串，
 * 与编译器得到的 `GDPR:ART6` 不一致。`mayReferenceControls` 只是「哪些版本值得解析」的子串预筛，
 * 与 governance-impact 的 SQL `LIKE '%@control%'` 同口径。
 */
import { parseSource, type Lexicon } from '@aster-cloud/aster-lang-ts/browser';
import { getLexicon } from '@/lib/aster-lexicon';

export type AliasSet = Record<string, readonly string[]> | null | undefined;

export interface ControlReferenceSource {
  readonly source: string;
  /** 版本的 CNL 语言（resolveStoredVersionLocale 的结果；短码与完整标签都可）。 */
  readonly locale: string;
  /** 版本冻结的关键词别名。 */
  readonly aliasSet: AliasSet;
}

export type ControlReferenceResult =
  | { readonly ok: true; readonly controls: string[] }
  | { readonly ok: false; readonly diagnostics: string[] };

const ANNOTATION = 'control';
const PREFILTER = `@${ANNOTATION}`;

/** 预筛：源码含 `@control` 字样才可能有引用（注释 / 字符串里的也算候选，交给解析判定）。 */
export function mayReferenceControls(source: string): boolean {
  return source.includes(PREFILTER);
}

/** 与引擎 resolvePolicyTypes 同一合并规则：版本别名叠加在 lexicon 自带别名之上。 */
function lexiconFor(locale: string, aliasSet: AliasSet): Lexicon {
  const base = getLexicon(locale);
  if (!aliasSet || Object.keys(aliasSet).length === 0) return base;
  return { ...base, aliases: { ...base.aliases, ...aliasSet } } as Lexicon;
}

/** 规则级 `@control` 注解的字符串参数（治理检查同口径：恰好一个字符串参数，空白视为无效）。 */
function controlArg(annotation: { name: string; args?: readonly { value: unknown }[] }): string | null {
  if (annotation.name !== ANNOTATION || annotation.args?.length !== 1) return null;
  const value = annotation.args[0].value;
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return key || null;
}

/** 解析源码，按首次出现顺序去重返回控制键；语法 / 词法错误时返回诊断码（调用方记入 unparsed）。 */
export function parseControlReferences(input: ControlReferenceSource): ControlReferenceResult {
  try {
    const { ast, diagnostics } = parseSource(input.source, lexiconFor(input.locale, input.aliasSet));
    const errors = diagnostics.filter((d) => d.severity === 'error').map((d) => String(d.code));
    if (errors.length > 0) return { ok: false, diagnostics: [...new Set(errors)] };
    const controls: string[] = [];
    for (const decl of ast.decls) {
      if (decl.kind !== 'Func') continue;
      for (const annotation of decl.annotations ?? []) {
        const key = controlArg(annotation);
        if (key && !controls.includes(key)) controls.push(key);
      }
    }
    return { ok: true, controls };
  } catch (err) {
    // 词法错误以 DiagnosticError 抛出；没有码的异常用 E000 占位，与 seed-compile-gate 一致
    const code = (err as { code?: unknown } | null)?.code;
    return { ok: false, diagnostics: [code ? String(code) : 'E000'] };
  }
}
