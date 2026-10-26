import {
  createPolicyApiClient,
  PolicyApiError,
  type PolicyCompileResponse,
} from '@/services/policy/policy-api';
import {
  DEFAULT_COMPILE_RETRY_AFTER_SECONDS,
  PolicyCompileError,
  PolicyCompileUnavailableError,
  type CompileValidator,
} from '@/services/policy/version-manager';
import { loadLiveVocabularyForPolicy } from '@/lib/domain-vocabulary-snapshot';

/** 取上游 429 错误体中的 retryAfter（秒），缺失或非法时回退默认值。 */
function retryAfterOf(err: PolicyApiError): number {
  const value = err.details?.retryAfter;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.ceil(value)
    : DEFAULT_COMPILE_RETRY_AFTER_SECONDS;
}

/** aster-api 编译端点内部故障码（ADR 0046 §4）：编译没做成，不是源码错误。 */
const COMPILE_INTERNAL_ERROR_CODE = 'COMPILE_INTERNAL_ERROR';

function compileDiagnosticsFrom(error: PolicyApiError) {
  const diagnostics = error.details?.diagnostics;
  if (!Array.isArray(diagnostics)) return [];
  return diagnostics
    .filter((diagnostic): diagnostic is Record<string, unknown> =>
      typeof diagnostic === 'object' && diagnostic !== null,
    )
    .filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => ({
      severity: 'error' as const,
      code: typeof diagnostic.code === 'string' ? diagnostic.code : 'compile_error',
      message: typeof diagnostic.message === 'string'
        ? diagnostic.message
        : 'Policy source could not be compiled.',
      startLine: typeof diagnostic.startLine === 'number' ? diagnostic.startLine : 1,
      startColumn: typeof diagnostic.startColumn === 'number' ? diagnostic.startColumn : 1,
    }));
}

// 源码错误 = 不带内部故障码的 error 诊断
function hasSourceError(diagnostics: PolicyCompileResponse['diagnostics']): boolean {
  return (diagnostics ?? []).some(
    (d) => d.severity === 'error' && d.code !== COMPILE_INTERNAL_ERROR_CODE,
  );
}

/**
 * 保存时编译所用的领域词汇：作者当前活跃词汇中该策略作用域内的部分（与编辑器注册、
 * 审批冻结同一规则，见 domain-vocabulary-scope）。加载失败退化为不带词汇编译，
 * 不因词汇库故障阻断保存。
 */
async function loadCompileVocabulary(
  userId: string,
  source: string,
  locale: string,
): Promise<Record<string, unknown> | null> {
  try {
    const vocabulary = await loadLiveVocabularyForPolicy(userId, { source, locale });
    return vocabulary ? (vocabulary as unknown as Record<string, unknown>) : null;
  } catch (err) {
    console.warn('[compile-gate] failed to load domain vocabulary', err);
    return null;
  }
}

/**
 * 构造保存前源码可编译性校验器，注入给 createVersion（覆盖所有版本创建入口）。
 *
 * 用与执行一致的输入（source + locale + aliasSet + 作用域内领域词汇）调 aster-api 的
 * POST /api/v1/policies/compile——依赖用户自定义别名的合法源码不会被「不带
 * alias 的编译」误判为解析错误（前后端语义一致）。
 *
 * 异常分类（关键）：
 * - 上游 4xx（如 aliasSet 超限 alias_set_too_large、请求非法）= 用户可修正的
 *   输入错误 → 抛 PolicyCompileError 拒绝落库（不 fail-open，否则坏输入被放行）。
 * - 上游 429（限流）= 编译检查暂不可用，不是用户输入错误 → 抛
 *   PolicyCompileUnavailableError，仍拒绝落库（防止限流期间放过 E705/E706），
 *   路由返回 503 + Retry-After。
 * - 上游 5xx / 超时 / 网络不可达 → 原样上抛，由 assertCompilable 决定：声明了治理档案的
 *   源码按不可用拒绝（503），未声明的 fail-open 放行（保存可用性不被编译服务可用性绑架）。
 * - 上游返回 success:false 且只有 COMPILE_INTERNAL_ERROR 诊断（api 内部故障），或兜底地
 *   没有任何 error 诊断 = 编译没做成而非源码有错/无错 → 抛普通错误，同样交给
 *   assertCompilable 按是否声明档案决定（503 或放行）。
 *
 * createVersion 只在返回的 diagnostics 含 severity==='error' 时拒绝落库。
 */
export function makeCompileValidator(userId: string): CompileValidator {
  return async ({ source, locale, aliasSet }) => {
    const client = createPolicyApiClient(userId, userId);
    const vocabulary = await loadCompileVocabulary(userId, source, locale);
    try {
      const result = await client.compile({
        source,
        locale,
        // aliasSet 类型收敛：CompileValidator 用 readonly，client 用可变；结构一致。
        aliasSet: aliasSet as Record<string, string[]> | null | undefined,
        vocabulary,
      });
      if (result.success === false && !hasSourceError(result.diagnostics)) {
        throw new Error(`compile unavailable: ${result.error ?? 'upstream failed without diagnostics'}`);
      }
      return { diagnostics: result.diagnostics, profile: result.profile };
    } catch (err) {
      if (err instanceof PolicyApiError && err.statusCode === 429) {
        throw new PolicyCompileUnavailableError(retryAfterOf(err));
      }
      // 4xx（含 aliasSet 超限）= 确定的用户输入错误 → 拒绝落库，不 fail-open。
      // 但 408/TIMEOUT 是「请求超时」= 服务不可达一类，不能当用户错误（client
      // 超时抛 PolicyApiError(408,'TIMEOUT')，见 policy-api request()）。5xx/网络
      // /超时 → 原样上抛，由 assertCompilable 按是否声明档案决定放行或拒绝。
      if (
        err instanceof PolicyApiError &&
        err.statusCode >= 400 &&
        err.statusCode < 500 &&
        err.statusCode !== 408 &&
        err.code !== 'TIMEOUT'
      ) {
        throw new PolicyCompileError(
          err.message || 'Policy could not be compiled. Check the source or aliases and try again.',
          compileDiagnosticsFrom(err),
        );
      }
      throw err;
    }
  };
}
