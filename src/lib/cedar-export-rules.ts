/**
 * 导出为 Cedar 时「导出哪一条规则」（issue #661，ADR 0047 §6）。
 *
 * aster-api 在未指定 functionName 且可导出的规则不止一条时返回 E720，原因文案列出候选：
 * `several rules can be exported (a, b); choose one`。候选是名称解析之后的规范名（ADR 0051），
 * 规则名经领域词汇本地化时与源码写法不同。
 *
 * 纯函数模块（无 Node 依赖）：路由用它校验调用方给的规则名属于该策略版本，面板用它从 E720 取候选。
 *
 * ★依赖：E720 诊断没有结构化的候选字段，只能从原因文案取；aster-api 改文案时须同步这里的正则
 *   （aster-api CedarExportService.functionRequiredReason）。
 */
import { extractRuleSymbols } from '@/lib/aster/rules';

/** E720 多候选原因中的候选列表 */
const SEVERAL_RULES = /several rules can be exported \(([^)]*)\); choose one/;

interface DiagnosticLike {
  code?: string;
  message: string;
}

/** 从导出诊断中取 E720 多候选；不是多候选的 E720（没有 guard 形态的规则）或没有 E720 时返回空数组。 */
export function cedarRuleCandidates(diagnostics: readonly DiagnosticLike[]): string[] {
  for (const d of diagnostics) {
    if (d.code !== 'E720') continue;
    const match = SEVERAL_RULES.exec(d.message);
    if (!match) continue;
    return match[1]!.split(',').map((name) => name.trim()).filter(Boolean);
  }
  return [];
}

interface FunctionMapping {
  canonical?: unknown;
  localized?: unknown;
  aliases?: unknown;
}

/** 词汇里本地化写法（含别名）→ 规范名 */
function functionCanonicals(vocabulary: Record<string, unknown> | undefined): Map<string, string> {
  const map = new Map<string, string>();
  const functions = Array.isArray(vocabulary?.functions) ? (vocabulary.functions as FunctionMapping[]) : [];
  for (const f of functions) {
    if (typeof f.canonical !== 'string') continue;
    const spellings = [f.localized, ...(Array.isArray(f.aliases) ? f.aliases : [])];
    for (const s of spellings) {
      if (typeof s === 'string') map.set(s, f.canonical);
    }
  }
  return map;
}

/**
 * 该版本源码中声明的规则名：源码写法，以及经版本词汇映射后的规范名（E720 候选用规范名）。
 * 规则声明按 Rule / 规则 / Regel 识别（与执行页的规则选择同一口径）。
 */
export function policyRuleNames(source: string, vocabulary?: Record<string, unknown>): Set<string> {
  const canonicals = functionCanonicals(vocabulary);
  const names = new Set<string>();
  for (const { name } of extractRuleSymbols(source)) {
    names.add(name);
    const canonical = canonicals.get(name);
    if (canonical) names.add(canonical);
  }
  return names;
}
