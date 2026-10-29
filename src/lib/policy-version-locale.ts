/**
 * 已存版本的 CNL 语言解析（secure-execute 与审批冻结共用）。
 *
 * PolicyVersion 没有单独的 locale 列，但保存时的编译 locale 已写进 sourceEnvelopeSha256
 * （content + aliasSet + locale + 工具链 + 词汇段，ADR 0051 §7）。按以下优先级取语言，保证旧版本执行口径不变：
 *   1. 版本记录的编译 locale：用候选 locale 重算 envelope，与存储值相等者即保存时所用值。
 *   2. 冻结快照引用的 locale 唯一时取之（secure-execute 原有口径，兼容无 envelope 的旧版本）。
 *   3. 最后才按源码关键词识别（detectCNLLocale，启发式）。
 */

import { computeSourceEnvelope, vocabularyScopesJson } from '@/lib/policy-alias';
import {
  loadFrozenVocabularyForSource,
  loadLiveVocabularyForSource,
  type SnapshotRef,
  type VocabularyForLocale,
  type VocabularyReader,
} from '@/lib/domain-vocabulary-snapshot';
import { executionVocabularySource } from '@/lib/execution-input';
import { detectCNLLocale } from '@/services/policy/cnl-executor';
import { CNL_LOCALES } from '@/lib/cnl-locale';
import { choosePolicyLocale } from '@/lib/policy-locale-priority';

/**
 * envelope 可能记录的 locale：新版本只会是受支持的规范标签（保存入口校验 + createVersion
 * 不变量）；旧版本保存时未校验，补上常见短码。
 */
const RECORDED_LOCALE_CANDIDATES = [
  ...CNL_LOCALES,
  ...CNL_LOCALES.map((locale) => locale.split('-')[0]!),
];

export interface StoredVersionLocaleInput {
  source: string;
  aliasSet: string | null;
  sourceEnvelopeSha256: string | null;
  sourceToolchainId: string | null;
  vocabularySnapshotIds: unknown;
  /** 版本状态：决定 envelope 词汇段取冻结快照还是作者现行词汇（与执行同口径）。 */
  status: string | null | undefined;
  /** 版本作者：草稿的现行词汇取自此人。 */
  createdBy: string | null | undefined;
}

/** 某个候选编译 locale 下 envelope 的第 5 段。 */
export type ScopesJsonForLocale = (locale: string) => string;

/** 从 envelope 反推保存时的编译 locale；无 envelope 或都不匹配时返回 undefined。 */
export function recordedCompileLocale(
  version: Omit<StoredVersionLocaleInput, 'status' | 'createdBy'>,
  scopesJsonFor: ScopesJsonForLocale,
): string | undefined {
  if (!version.sourceEnvelopeSha256) return undefined;
  return RECORDED_LOCALE_CANDIDATES.find(
    (locale) =>
      computeSourceEnvelope(
        version.source,
        version.aliasSet,
        locale,
        version.sourceToolchainId,
        scopesJsonFor(locale),
      ) === version.sourceEnvelopeSha256,
  );
}

/** 词汇来源与执行一致：已审批/已弃用取冻结快照，其余取作者现行词汇（无作者则无词汇）。 */
async function loadVersionVocabulary(
  version: StoredVersionLocaleInput,
  exec?: VocabularyReader,
): Promise<VocabularyForLocale> {
  if (executionVocabularySource(version.status) === 'frozen') {
    return loadFrozenVocabularyForSource(version.vocabularySnapshotIds as SnapshotRef[] | null, version.source);
  }
  if (!version.createdBy) return () => null;
  return loadLiveVocabularyForSource(version.createdBy, version.source, exec);
}

/**
 * 每个候选 locale 下的 envelope 词汇段。只用于反推语言（不是门禁），故 best-effort：
 * 词汇加载失败或某 locale 下源码无法词法分析/词汇非法时按无词汇处理，反推不中则走兜底链。
 */
async function loadScopesJsonForLocale(
  version: StoredVersionLocaleInput,
  exec?: VocabularyReader,
): Promise<ScopesJsonForLocale> {
  let vocabularyFor: VocabularyForLocale;
  try {
    vocabularyFor = await loadVersionVocabulary(version, exec);
  } catch (err) {
    console.warn('[policy-version-locale] failed to load vocabulary for envelope locale recovery', err);
    return () => '';
  }
  return (locale) => {
    try {
      return vocabularyScopesJson(vocabularyFor(locale));
    } catch {
      return '';
    }
  };
}

/** 快照引用的 locale 唯一时返回该值，否则 undefined。 */
function uniqueSnapshotLocale(refs: unknown): string | undefined {
  if (!Array.isArray(refs)) return undefined;
  const locales = new Set(
    refs.map((ref) => (ref as { locale?: unknown }).locale).filter((l): l is string => typeof l === 'string' && l !== ''),
  );
  return locales.size === 1 ? [...locales][0] : undefined;
}

/**
 * 已存版本的 CNL 语言（优先级见文件头，判定顺序统一由 policy-locale-priority 提供）。
 * 执行、审批冻结与编辑页都调用它，因此编辑器显示的语言与执行使用的语言一致（#627）。
 * exec：审批事务内调用时传 tx，避免事务中再占一条全局连接。
 */
export async function resolveStoredVersionLocale(
  version: StoredVersionLocaleInput,
  exec?: VocabularyReader,
): Promise<string> {
  const recorded = version.sourceEnvelopeSha256
    ? recordedCompileLocale(version, await loadScopesJsonForLocale(version, exec))
    : undefined;
  if (!recorded && version.sourceEnvelopeSha256) {
    // 有 envelope 却反推不出：保存时用了不受支持的 locale、ADR 0051 前的 4 段 envelope 尚未迁移，
    // 或词汇在保存后变化（草稿现行词汇被编辑、审批冻结与保存时不同），只能走兜底链。
    console.warn('[policy-version-locale] recorded compile locale not recoverable; falling back');
  }
  return choosePolicyLocale({
    recorded,
    snapshotLocale: uniqueSnapshotLocale(version.vocabularySnapshotIds),
    source: version.source,
    detect: detectCNLLocale,
  });
}
