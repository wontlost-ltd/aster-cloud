/**
 * 执行前的输入准备（#626）：dashboard / v1 / secure-execute 三条执行路径共用。
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

import { loadExecutionVocabulary, loadLiveVocabularyForPolicy } from '@/lib/domain-vocabulary-snapshot';
import {
  buildVocabularyNameIndex,
  canonicalName,
  localizeExecutionOutput,
  mapExecutionInput,
  mapFunctionName,
  type AmbiguousInputField,
} from './mapper';
import { extractPolicyInputTypes } from './policy-types';

export { buildVocabularyNameIndex, mapExecutionInput, localizeExecutionOutput, mapFunctionName } from './mapper';
export type { AmbiguousInputField, PolicyInputTypes, VocabularyNameIndex } from './mapper';

/** 同一对象内本地化键与规范键（或两个同义词）同时出现时的稳定错误码。 */
export const AMBIGUOUS_INPUT_FIELD_CODE = 'ambiguous_input_field';

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
  /** 草稿执行时取谁的现行词汇：版本作者，缺省为策略所有者。 */
  authorId: string | null | undefined;
  source: string;
  locale: string;
}

/**
 * 加载被执行版本的领域词汇，best-effort：加载失败退化为不带词汇执行（与修复前一致），
 * 返回值可直接作为 evaluateSource 的 vocabulary 选项。
 */
export async function loadVersionExecutionVocabulary(
  target: ExecutionVocabularyTarget,
): Promise<Record<string, unknown> | undefined> {
  const policy = { source: target.source, locale: target.locale };
  if (executionVocabularySource(target.status) === 'frozen') {
    return loadExecutionVocabulary(target.vocabularySnapshotIds, policy);
  }
  if (!target.authorId) return undefined;
  try {
    const vocab = await loadLiveVocabularyForPolicy(target.authorId, policy);
    return vocab ? (vocab as unknown as Record<string, unknown>) : undefined;
  } catch (err) {
    console.warn('[vocabulary] failed to load live vocabulary for draft execution', err);
    return undefined;
  }
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
      /** 把结果里的规范名还原为策略语言（界面展示用）。 */
      localizeOutput: (value: unknown) => unknown;
    }
  | { ok: false; ambiguous: AmbiguousInputField };

/** 执行前映射输入与函数名。无词汇时零开销（不编译源码）。 */
export function prepareExecutionInput(params: PrepareExecutionInputParams): PreparedExecutionInput {
  const index = buildVocabularyNameIndex(params.vocabulary);
  if (!index) {
    return { ok: true, input: params.input, functionName: params.functionName, localizeOutput: (v) => v };
  }
  const types = extractPolicyInputTypes(
    params.source, params.locale, params.aliasSet, params.functionName, (name) => canonicalName(index, name),
  );
  const mapped = mapExecutionInput(params.input, index, types);
  if (!mapped.ok) return mapped;
  return {
    ok: true,
    input: mapped.input,
    functionName: mapFunctionName(params.functionName, index),
    localizeOutput: (value) => localizeExecutionOutput(value, index, types),
  };
}

/** 歧义输入的 400 响应体（dashboard / v1 共用；secure-execute 另加其 errorCode 口径）。 */
export function ambiguousInputFieldBody(ambiguous: AmbiguousInputField) {
  const [first, second] = ambiguous.fields;
  return {
    error:
      `Input fields "${first}" and "${second}" both refer to the policy field "${ambiguous.policyName}". ` +
      'Send only one of them.',
    code: AMBIGUOUS_INPUT_FIELD_CODE,
    field: ambiguous.field,
    fields: ambiguous.fields,
    policyField: ambiguous.policyName,
  };
}
