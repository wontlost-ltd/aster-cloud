/**
 * 已存版本的 CNL 语言解析（secure-execute 与审批冻结共用）。
 *
 * PolicyVersion 没有单独的 locale 列，但保存时的编译 locale 已写进 sourceEnvelopeSha256
 * （content + aliasSet + locale + 工具链）。按以下优先级取语言，保证旧版本执行口径不变：
 *   1. 版本记录的编译 locale：用候选 locale 重算 envelope，与存储值相等者即保存时所用值。
 *   2. 冻结快照引用的 locale 唯一时取之（secure-execute 原有口径，兼容无 envelope 的旧版本）。
 *   3. 最后才按源码关键词识别（detectCNLLocale，启发式）。
 */

import { computeSourceEnvelope } from '@/lib/policy-alias';
import { detectCNLLocale } from '@/services/policy/cnl-executor';

/** 保存入口可能写入 envelope 的 locale 拼写（编辑器传完整标签，API 调用方可能传短码）。 */
const RECORDED_LOCALE_CANDIDATES = ['en-US', 'zh-CN', 'de-DE', 'hi-IN', 'en', 'zh', 'de', 'hi'];

export interface StoredVersionLocaleInput {
  source: string;
  aliasSet: string | null;
  sourceEnvelopeSha256: string | null;
  sourceToolchainId: string | null;
  vocabularySnapshotIds: unknown;
}

/** 从 envelope 反推保存时的编译 locale；无 envelope 或都不匹配时返回 undefined。 */
export function recordedCompileLocale(version: StoredVersionLocaleInput): string | undefined {
  if (!version.sourceEnvelopeSha256) return undefined;
  return RECORDED_LOCALE_CANDIDATES.find(
    (locale) =>
      computeSourceEnvelope(version.source, version.aliasSet, locale, version.sourceToolchainId) ===
      version.sourceEnvelopeSha256,
  );
}

/** 快照引用的 locale 唯一时返回该值，否则 undefined。 */
function uniqueSnapshotLocale(refs: unknown): string | undefined {
  if (!Array.isArray(refs)) return undefined;
  const locales = new Set(
    refs.map((ref) => (ref as { locale?: unknown }).locale).filter((l): l is string => typeof l === 'string' && l !== ''),
  );
  return locales.size === 1 ? [...locales][0] : undefined;
}

/** 已存版本的 CNL 语言（优先级见文件头）。 */
export function resolveStoredVersionLocale(version: StoredVersionLocaleInput): string {
  return (
    recordedCompileLocale(version) ??
    uniqueSnapshotLocale(version.vocabularySnapshotIds) ??
    detectCNLLocale(version.source)
  );
}
