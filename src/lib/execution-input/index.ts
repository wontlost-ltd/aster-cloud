/**
 * 执行前的输入准备（#626）：dashboard / v1 两条执行路径共用。
 *
 * 1. 词汇来源（唯一切换点 {@link executionVocabularySource}）：
 *    - 已审批 / 已弃用版本：审批时冻结的快照（只取策略作用域内的部分）；
 *    - 其它版本（草稿、待审批、被拒、无版本记录的旧策略）：作者**现行**词汇中策略作用域内的部分
 *      （与审批冻结同一规则：domain-vocabulary-scope，严格词法）。偏离 ADR 0014「草稿不带词汇执行」，
 *      使草稿能按策略语言输入执行；审批仍然冻结快照，已审批版本不受之后的词条编辑影响。
 *    同一份词汇既透传给引擎规范化源码，也用于下面的输入映射，二者口径一致。
 * 2. 输入映射：策略语言的字段名 / 枚举值 / 类型标签 → 规范名（规则见 ./mapper）。
 *    同一对象内两个键指向同一字段时返回 400 ambiguous_input_field，不猜测。
 */

import {
  loadExecutionVocabulary,
  loadLiveVocabularyForPolicy,
  loadVocabularyForExecution,
  type SnapshotRef,
} from '@/lib/domain-vocabulary-snapshot';
import {
  buildExecutionVocabulary,
  buildMappingModel,
  localizeExecutionOutput,
  mapExecutionInput,
  type AmbiguousInputField,
  type InputRename,
} from './mapper';
import { extractPolicyInputTypes } from './policy-types';
import { recordInputTypeExtraction } from '@/lib/lexicon-metrics';
import { resolveStoredVersionLocale, type StoredVersionLocaleInput } from '@/lib/policy-version-locale';

export { buildExecutionVocabulary, buildMappingModel, mapExecutionInput, localizeExecutionOutput } from './mapper';
export type { AmbiguousInputField, ExecutionVocabulary, InputRename, MappingModel, PolicyInputTypes } from './mapper';

/** 同一对象内本地化键与规范键（或两个同义词）同时出现时的稳定错误码。 */
export const AMBIGUOUS_INPUT_FIELD_CODE = 'ambiguous_input_field';

/**
 * 带词汇的版本取不到输入类型时的稳定错误码（#638）：此时无法把策略语言的输入映射为规范名，
 * 在未映射的输入上执行只会让每条规则都失败，所以拒绝执行（422）而不是静默透传。
 */
export const INPUT_TYPE_EXTRACTION_FAILED_CODE = 'input_type_extraction_failed';

/**
 * 带词汇的版本未指定 Rule、且无法唯一确定入口（多个 Rule、无 @entry）时的稳定错误码：
 * 不知道引擎会执行哪条，就无法按它的参数类型映射输入（执行端同样会拒绝）。
 */
export const ENTRY_RULE_REQUIRED_CODE = 'entry_rule_required';

/** 冻结快照生效的版本状态；其余状态按作者现行词汇执行。 */
const FROZEN_VOCABULARY_STATUSES: ReadonlySet<string> = new Set(['APPROVED', 'DEPRECATED']);

export type ExecutionVocabularySource = 'frozen' | 'live';

/** 版本执行用哪份词汇。状态未知（无版本记录的旧策略）按草稿处理。 */
export function executionVocabularySource(status: string | null | undefined): ExecutionVocabularySource {
  return status && FROZEN_VOCABULARY_STATUSES.has(status) ? 'frozen' : 'live';
}

export interface ExecutionVocabularyTarget {
  /** 被执行版本的状态（PolicyVersion.status）。 */
  status: string | null | undefined;
  /** 被执行版本的 vocabularySnapshotIds（冻结快照引用）。 */
  vocabularySnapshotIds: unknown;
  /**
   * 草稿执行时取谁的现行词汇：版本作者（PolicyVersion.createdBy），与审批冻结取词汇的口径一致
   * （团队策略里作者可不是所有者）；作者为空时审批也不冻结任何词汇，这里同样不带词汇。
   */
  authorId: string | null | undefined;
  source: string;
  locale: string;
}

/** 词汇加载失败的稳定错误码，与保存入口的 503 vocabulary_unavailable 同码。 */
export const VERSION_VOCABULARY_UNAVAILABLE_CODE = 'vocabulary_unavailable';

/**
 * 严格模式下版本词汇加载失败（数据库不可用等）。What-If 重放、Cedar 导出、回归基线必须与执行用同一份词汇，
 * 退化为无词汇会得到误导性的编译错误或被静默算错的结果，故按暂不可用拒绝，由调用方映射为 503 / 不可回放。
 */
export class VersionVocabularyUnavailableError extends Error {
  readonly code = VERSION_VOCABULARY_UNAVAILABLE_CODE;
  /** 建议的重试间隔（秒），与保存入口编译门禁的默认值一致。 */
  readonly retryAfterSeconds = 60;

  constructor(cause: unknown) {
    super('Domain vocabulary could not be loaded. Try again later.', { cause });
    this.name = 'VersionVocabularyUnavailableError';
  }
}

/** 作者词汇非法（引擎 VocabularyScopeError）是确定性的输入问题，不是加载失败，严格模式下原样上抛。 */
function isVocabularyScopeError(err: unknown): boolean {
  return err instanceof Error && err.name === 'VocabularyScopeError';
}

async function loadVersionVocabularyStrict(
  target: ExecutionVocabularyTarget,
): Promise<Record<string, unknown> | undefined> {
  const policy = { source: target.source, locale: target.locale };
  if (executionVocabularySource(target.status) !== 'frozen' && !target.authorId) return undefined;
  try {
    const vocab = executionVocabularySource(target.status) === 'frozen'
      ? await loadVocabularyForExecution(target.vocabularySnapshotIds as SnapshotRef[] | null, policy)
      : await loadLiveVocabularyForPolicy(target.authorId!, policy);
    return vocab ? (vocab as unknown as Record<string, unknown>) : undefined;
  } catch (err) {
    if (isVocabularyScopeError(err)) throw err;
    throw new VersionVocabularyUnavailableError(err);
  }
}

/**
 * 加载被执行版本的领域词汇，返回值可直接作为 evaluateSource 的 vocabulary 选项。
 * - 默认 best-effort（执行路径）：加载失败退化为不带词汇执行（与修复前一致）；
 * - strict（重编译 / 回放路径）：加载失败抛 {@link VersionVocabularyUnavailableError}，作者词汇非法原样上抛。
 */
export async function loadVersionExecutionVocabulary(
  target: ExecutionVocabularyTarget,
  options: { strict?: boolean } = {},
): Promise<Record<string, unknown> | undefined> {
  if (options.strict) return loadVersionVocabularyStrict(target);
  const policy = { source: target.source, locale: target.locale };
  if (executionVocabularySource(target.status) === 'frozen') {
    return loadExecutionVocabulary(target.vocabularySnapshotIds, policy);
  }
  if (!target.authorId) {
    // 与审批冻结同口径：无作者的版本不带词汇。生产上应不存在，留日志便于观察。
    console.debug('[vocabulary] draft version has no author; executing without vocabulary');
    return undefined;
  }
  try {
    const vocab = await loadLiveVocabularyForPolicy(target.authorId, policy);
    return vocab ? (vocab as unknown as Record<string, unknown>) : undefined;
  } catch (err) {
    console.warn('[vocabulary] failed to load live vocabulary for draft execution', err);
    return undefined;
  }
}

/** 已存版本的编译上下文所需字段（PolicyVersion 行的子集；source 为版本源码）。 */
export interface StoredVersionCompileInput extends StoredVersionLocaleInput {
  status: string | null | undefined;
  createdBy: string | null | undefined;
}

export interface StoredVersionCompileContext {
  /** 版本的编译语言（与执行同一判定，见 policy-version-locale）。 */
  locale: string;
  /** 版本的领域词汇（DomainVocabulary JSON）；无作用域内词汇时为 undefined。 */
  vocabulary: Record<string, unknown> | undefined;
}

/**
 * 已存版本交给 aster-api 重新编译时的语言与词汇（What-If 重放、Cedar 导出与执行同一口径）：
 * 已审批 / 已弃用取冻结快照，草稿取作者现行词汇（ADR 0051 §7）。词汇严格加载：失败抛
 * {@link VersionVocabularyUnavailableError}，作者词汇非法抛引擎 VocabularyScopeError，不退化为无词汇。
 */
export async function loadStoredVersionCompileContext(
  version: StoredVersionCompileInput,
): Promise<StoredVersionCompileContext> {
  const locale = resolveStoredVersionLocale(version);
  const vocabulary = await loadVersionExecutionVocabulary({
    status: version.status,
    vocabularySnapshotIds: version.vocabularySnapshotIds,
    authorId: version.createdBy,
    source: version.source,
    locale,
  }, { strict: true });
  return { locale, vocabulary };
}

export interface PrepareExecutionInputParams {
  input: unknown;
  functionName: string | undefined;
  /** 透传给引擎的同一份词汇；undefined 表示无词汇，输入原样透传。 */
  vocabulary: Record<string, unknown> | undefined;
  source: string;
  locale: string;
  /** 版本冻结的关键词别名：只用于解析源码取类型，不参与输入映射。 */
  aliasSet: Record<string, readonly string[]> | null | undefined;
}

export type PreparedExecutionInput =
  | {
      ok: true;
      /** 交给引擎的规范输入（也是 Execution.input 落库值：回放 / parity / guard 用它）。 */
      input: unknown;
      functionName: string | undefined;
      /** 映射改写了哪些位置（审计用；无改写时为空）。 */
      renames: readonly InputRename[];
      /** 把结果里的规范名还原为策略语言（界面展示用）。 */
      localizeOutput: (value: unknown) => unknown;
    }
  | { ok: false; reason: 'ambiguous'; ambiguous: AmbiguousInputField }
  /** diagnostics：引擎诊断码（如 P005、E802），供界面与排障定位。 */
  | { ok: false; reason: 'type_extraction_failed'; diagnostics: readonly string[] }
  | { ok: false; reason: 'entry_ambiguous'; rules: readonly string[] };

/**
 * 执行前映射输入与函数名。无词汇时零开销（不解析源码）。
 * 类型取自引擎 resolvePolicyTypes，与执行同一份词汇、同一 locale；失败时记日志 + 指标并返回
 * type_extraction_failed（带引擎诊断码）。
 */
export function prepareExecutionInput(params: PrepareExecutionInputParams): PreparedExecutionInput {
  const vocabulary = buildExecutionVocabulary(params.vocabulary);
  if (!vocabulary) {
    return { ok: true, input: params.input, functionName: params.functionName, renames: [], localizeOutput: (v) => v };
  }
  const extracted = extractPolicyInputTypes(
    { source: params.source, locale: params.locale, aliasSet: params.aliasSet, vocabulary },
    params.functionName,
  );
  recordInputTypeExtraction(extracted.ok ? 'ok' : extracted.reason);
  if (!extracted.ok) {
    console.warn('[execution-input] input types unavailable; refusing to execute on unmapped input', {
      locale: params.locale, functionName: params.functionName, reason: extracted.reason,
    });
    return extracted.reason === 'entry_ambiguous'
      ? { ok: false, reason: 'entry_ambiguous', rules: extracted.rules }
      : { ok: false, reason: 'type_extraction_failed', diagnostics: extracted.diagnostics };
  }
  const model = buildMappingModel(vocabulary, extracted.types);
  const mapped = mapExecutionInput(params.input, model);
  if (!mapped.ok) return { ok: false, reason: 'ambiguous', ambiguous: mapped.ambiguous };
  return {
    ok: true,
    input: mapped.input,
    functionName: extracted.functionName,
    renames: mapped.renames,
    localizeOutput: (value) => localizeExecutionOutput(value, model),
  };
}

/**
 * 结果本地化后与原值不同时才返回 localizedResult（新增可选字段，旧客户端忽略即可）。
 * 本地化按返回类型递归进行：枚举值（字符串或运行时枚举对象）、结构字段名、列表元素都会还原。
 */
export function localizedResultField(result: unknown, localize: (value: unknown) => unknown): { localizedResult?: unknown } {
  if (result === undefined || result === null) return {};
  const localized = localize(result);
  return JSON.stringify(localized) === JSON.stringify(result) ? {} : { localizedResult: localized };
}

/** 歧义输入的 400 响应体（dashboard / v1 共用）。 */
export function ambiguousInputFieldBody(ambiguous: AmbiguousInputField) {
  return {
    error: ambiguousInputFieldMessage(ambiguous),
    code: AMBIGUOUS_INPUT_FIELD_CODE,
    field: ambiguous.field,
    fields: ambiguous.fields,
    policyField: ambiguous.policyName,
    ...(ambiguous.candidates ? { candidates: ambiguous.candidates } : {}),
  };
}

/** 类型提取失败的英文说明（界面按 code 本地化）。 */
export const INPUT_TYPE_EXTRACTION_FAILED_MESSAGE =
  'The input types of this policy version could not be read, so the input cannot be matched to the ' +
  'policy vocabulary. The policy was not executed. Check that the policy source compiles, then try again.';

/** 未指定 Rule 且入口不唯一时的英文说明（界面按 code 本地化）。 */
export const ENTRY_RULE_REQUIRED_MESSAGE =
  'This policy has several rules and none is marked @entry. Choose the rule to run with functionName.';

/**
 * 准备失败时 dashboard / v1 共用的响应：歧义 400，类型提取失败 422。
 */
export function preparedInputErrorResponse(
  failure: Extract<PreparedExecutionInput, { ok: false }>,
): { body: Record<string, unknown>; status: number } {
  if (failure.reason === 'ambiguous') return { body: ambiguousInputFieldBody(failure.ambiguous), status: 400 };
  if (failure.reason === 'entry_ambiguous') {
    return { body: { error: ENTRY_RULE_REQUIRED_MESSAGE, code: ENTRY_RULE_REQUIRED_CODE, rules: failure.rules }, status: 422 };
  }
  return {
    body: { error: INPUT_TYPE_EXTRACTION_FAILED_MESSAGE, code: INPUT_TYPE_EXTRACTION_FAILED_CODE, diagnostics: failure.diagnostics },
    status: 422,
  };
}

/** 歧义的英文说明（界面按 code 本地化；措辞与界面文案 execute.ambiguousInput* 同一口径）。 */
export function ambiguousInputFieldMessage(ambiguous: AmbiguousInputField): string {
  if (ambiguous.candidates) {
    return `The input field "${ambiguous.field}" matches several fields in this policy's vocabulary ` +
      `(${ambiguous.candidates.join(', ')}). Use the canonical field name instead.`;
  }
  const [first, second] = ambiguous.fields;
  return `The input contains the policy field "${ambiguous.policyName}" twice ("${first}" and "${second}": ` +
    'its policy-language name and its canonical name, or two synonyms). Keep only one of them.';
}
