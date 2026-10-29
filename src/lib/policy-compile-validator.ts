import {
  createPolicyApiClient,
  PolicyApiError,
  type PolicyCompileResponse,
} from '@/services/policy/policy-api';
import {
  DEFAULT_COMPILE_RETRY_AFTER_SECONDS,
  PolicyCompileError,
  PolicyCompileUnavailableError,
  VOCABULARY_UNAVAILABLE_CODE,
  type CompileValidator,
} from '@/services/policy/version-manager';
import { loadLiveVocabularyForPolicy } from '@/lib/domain-vocabulary-snapshot';
import type { PolicyVocabularyContext } from '@/lib/domain-vocabulary-scope';
import { vocabularyScopesJson } from '@/lib/policy-alias';
import type { DomainVocabulary } from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';

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

/**
 * 源码错误 = 不带内部故障码的 error 诊断。只有内部故障码的诊断表示编译没做成，
 * 不论上游以 200 success:false 还是 4xx 返回，都不能当作源码错误（保存拒绝 / 迁移归档）。
 */
export function hasSourceError(
  diagnostics: PolicyCompileResponse['diagnostics'] | readonly { severity?: string; code?: string }[],
): boolean {
  return (diagnostics ?? []).some(
    (d) => d.severity === 'error' && d.code !== COMPILE_INTERNAL_ERROR_CODE,
  );
}

/** 一次保存所用的作者词汇：编译门禁与 envelope 封印共用同一份，二者不会分叉。 */
export interface SaveVocabulary {
  /** 作者现行词汇中该策略作用域内的部分；无则 null。 */
  vocabulary: DomainVocabulary | null;
  /** envelope 第 5 段（ADR 0051 §7）。 */
  scopesJson: string;
}

/**
 * 每次保存只加载一次作者现行词汇（作用域规则同编辑器注册与审批冻结，见 domain-vocabulary-scope），
 * 并据此算出 envelope 词汇段。
 * - 加载失败：编译门禁与封印都没有可信的词汇输入，按暂不可用拒绝（503 可重试，码为
 *   vocabulary_unavailable，与编译服务不可用区分），不退化为无词汇——否则落库的 envelope 与实际编译输入不一致。
 * - 词汇非法（字段/枚举成员缺 parent、字面量冲突）：引擎抛 VocabularyScopeError，原样上抛，
 *   由保存入口映射为 400 vocabulary_scope_invalid。
 */
export async function loadSaveVocabulary(
  userId: string,
  policy: PolicyVocabularyContext,
): Promise<SaveVocabulary> {
  let vocabulary: DomainVocabulary | null;
  try {
    vocabulary = await loadLiveVocabularyForPolicy(userId, policy);
  } catch (err) {
    console.warn('[compile-gate] failed to load domain vocabulary', err);
    throw new PolicyCompileUnavailableError(
      DEFAULT_COMPILE_RETRY_AFTER_SECONDS,
      'Domain vocabulary could not be loaded. Try again later.',
      VOCABULARY_UNAVAILABLE_CODE,
    );
  }
  return { vocabulary, scopesJson: vocabularyScopesJson(vocabulary) };
}

/**
 * 构造保存前源码可编译性校验器，注入给 createVersion（覆盖所有版本创建入口）。
 * saveVocabulary 为本次保存经 {@link loadSaveVocabulary} 加载的同一份作者词汇（与 envelope 封印共用）。
 *
 * 用与执行一致的输入（source + locale + aliasSet + 结构词授权 + 作用域内领域词汇）调 aster-api 的
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
 * - 上游返回 success:false 或 4xx 且只有 COMPILE_INTERNAL_ERROR 诊断（api 内部故障），或兜底地
 *   没有任何 error 诊断 = 编译没做成而非源码有错/无错 → 抛普通错误，同样交给
 *   assertCompilable 按是否声明档案决定（503 或放行）。
 *
 * createVersion 只在返回的 diagnostics 含 severity==='error' 时拒绝落库。
 * tenantId 缺省为 userId（个人租户）；按已存版本重编译时传策略所属租户（policyTenantId）。
 */
export function makeCompileValidator(
  userId: string,
  saveVocabulary: DomainVocabulary | null,
  tenantId: string = userId,
): CompileValidator {
  const vocabulary = saveVocabulary as unknown as Record<string, unknown> | null;
  return async ({ source, locale, aliasSet, allowStructural }) => {
    const client = createPolicyApiClient(tenantId, userId);
    try {
      const result = await client.compile({
        source,
        locale,
        // aliasSet 类型收敛：CompileValidator 用 readonly，client 用可变；结构一致。
        aliasSet: aliasSet as Record<string, string[]> | null | undefined,
        allowStructural,
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
        const diagnostics = compileDiagnosticsFrom(err);
        if (diagnostics.length > 0 && !hasSourceError(diagnostics)) {
          throw new Error(`compile unavailable: HTTP ${err.statusCode} with only internal diagnostics`);
        }
        throw new PolicyCompileError(
          err.message || 'Policy could not be compiled. Check the source or aliases and try again.',
          diagnostics,
        );
      }
      throw err;
    }
  };
}
