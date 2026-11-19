/**
 * Node 策略包导出前的 Worker 内复核（ADR 0059 P2 T27，修订 3 P2-R5 / P2-R13）。
 *
 * B 包在用户机器上由 npm `aster` 本地重编译再运行，所以导出 target=node 之前，cloud 用自身依赖的
 * aster-lang-ts（`./package-check` 子路径）按同一编译输入复核 aster-api `prepare` 的结果：
 *   1. 本地 ts 版本 ≠ 锁文件 `node.cliVersion` → skew（路由 503 export_runtime_skew）；
 *   2. 重编译的投影哈希 ≠ 平台 `positionFreeSha256`（或 ts 编译失败）→ E739；
 *   3. 在平台 Core IR 上逐条跑探针，有任一不一致 → E735；
 *   4. 全部一致 → 交给 aster-api 签名的 `nodeProbes`。
 * 只拒绝、不降级：超步数、栈溢出、超时都按不一致处理。诊断形状与 aster-api 的导出诊断相同（无位置记 1:1）。
 */
import {
  CompileFailure,
  TS_VERSION,
  checkProbes,
  compileSourcePositionFreeSha256,
} from '@aster-cloud/aster-lang-ts/package-check';
import type {
  PackageExportPrepareResponse,
  PackageExportRequest,
  PackageNodeProbes,
  PolicyDiagnostic,
} from '@/services/policy/policy-api';

/**
 * 探针比对上限（修订 3 P2-R13）。Workers 同步执行期间 `Date.now()` 不推进，`deadlineMs` 在那里实际不触发，
 * 真正约束总耗时的是合计步数预算 `maxTotalSteps`：每条 5M、合计 60M（裁决），用尽后其余各条计为不一致（E735）。
 */
export const NODE_CHECK_LIMITS = {
  maxSteps: 5_000_000,
  maxCallDepth: 10_000,
  deadlineMs: 20_000,
  maxTotalSteps: 60_000_000,
} as const;

/** 重编译所需的编译输入：与提交给 aster-api 的请求体同一份 */
export type NodeCheckCompileInput = Pick<PackageExportRequest, 'source' | 'locale' | 'aliasSet' | 'allowStructural' | 'vocabulary'>;

export type NodeCheckResult =
  | { ok: true; nodeProbes: PackageNodeProbes }
  | { ok: false; diagnostics: PolicyDiagnostic[] }
  | { ok: false; skew: true };

/** 英文模板与 aster-api `ExportDiagnosticCode` / ts `shared/error_codes.json` 逐字相同 */
const TEMPLATES = {
  E735: 'Node probe {probe} disagrees with the platform: expected {expected}, got {actual}',
  E739: 'Node recompilation of the policy differs from the platform Core IR (positionFreeSha256 {platform} vs {node})',
} as const;

function diagnostic(code: keyof typeof TEMPLATES, params: Record<string, string>): PolicyDiagnostic {
  // 单遍替换：参数值（如探针里的文本）中出现的 `{x}` 或 `$&` 不会被再次解释
  const message = TEMPLATES[code].replace(/\{(\w+)\}/g, (m: string, k: string) => params[k] ?? m);
  return { severity: 'error', message, startLine: 1, startColumn: 1, endLine: 1, endColumn: 1, code };
}

/** 重编译的投影哈希；ts 拒绝平台已接受的源码同样是漂移，记为 `compile-failed` */
function nodePositionFreeSha256(input: NodeCheckCompileInput): string {
  try {
    return compileSourcePositionFreeSha256(input.source, {
      locale: input.locale,
      aliasSetJson: JSON.stringify(input.aliasSet ?? null),
      allowStructural: input.allowStructural === true,
      ...(input.vocabulary ? { vocabularyJson: JSON.stringify(input.vocabulary) } : {}),
    });
  } catch (error) {
    if (error instanceof CompileFailure) return 'compile-failed';
    throw error;
  }
}

/** prepare 结果中比对必需的字段；缺失说明上游响应不完整，抛错由路由按上游错误处理 */
function required(prepared: PackageExportPrepareResponse) {
  const { entry, coreIr, positionFreeSha256, probesJson, probesSha256, runtime } = prepared;
  if (!entry || !coreIr || !positionFreeSha256 || !probesJson || !probesSha256 || !runtime) {
    throw new Error('package prepare response is missing fields required for the Node check');
  }
  return { entry, coreIr, positionFreeSha256, probesJson, probesSha256, cliVersion: runtime.cliVersion };
}

/**
 * 复核一个可导出的 prepare 结果（调用方先处理 exportable=false）。
 * 平台 Core IR / 探针文件本身不可读（CoreIrFormatError 等）属于平台缺陷而非 Node 不一致，原样抛出。
 */
export function runNodeCheck(
  prepared: PackageExportPrepareResponse,
  input: NodeCheckCompileInput,
  /** cloud 依赖的 aster-lang-ts 版本（构建时盖章）；测试注入 */
  tsVersion: string = TS_VERSION,
): NodeCheckResult {
  const p = required(prepared);
  if (tsVersion !== p.cliVersion) return { ok: false, skew: true };

  const node = nodePositionFreeSha256(input);
  if (node !== p.positionFreeSha256) {
    return { ok: false, diagnostics: [diagnostic('E739', { platform: p.positionFreeSha256, node })] };
  }

  const result = checkProbes(p.coreIr, p.probesJson, { ...NODE_CHECK_LIMITS, entries: [p.entry] });
  if (result.firstMismatch) {
    const { index, expected, actual } = result.firstMismatch;
    return { ok: false, diagnostics: [diagnostic('E735', { probe: String(index), expected, actual })] };
  }
  return {
    ok: true,
    nodeProbes: { probesSha256: p.probesSha256, count: result.count, agreed: result.agreed, tsVersion },
  };
}
