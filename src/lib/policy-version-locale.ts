/**
 * 已存版本的 CNL 语言解析（secure-execute 与审批冻结共用）。
 *
 * PolicyVersion 没有单独的 locale 列，但保存时的编译 locale 已写进 sourceEnvelopeSha256
 * （content + aliasSet + locale + 工具链 + 词汇段，ADR 0051 §7）。词汇段取封印时落库的
 * sourceScopesJson，不按现行/快照词汇重推，故之后编辑词条或审批冻结都不影响反推。按以下优先级取语言，保证旧版本执行口径不变：
 *   1. 版本记录的编译 locale：用候选 locale 重算 envelope，与存储值相等者即保存时所用值。
 *   2. 冻结快照引用的 locale 唯一时取之（secure-execute 原有口径，兼容无 envelope 的旧版本）。
 *   3. 最后才按源码关键词识别（detectCNLLocale，启发式）。
 */

import { createHash } from 'node:crypto';
import { computeSourceEnvelope } from '@/lib/policy-alias';
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
  /** 封印 envelope 时的词汇段；NULL = ADR 0051 前的旧行（4 段 envelope，待迁移回填）。 */
  sourceScopesJson: string | null;
  vocabularySnapshotIds: unknown;
}

/**
 * ADR 0051 之前的 4 段 envelope（content, aliasSetJson, locale, toolchainId），与 Java
 * PolicyVersion.computeLegacySourceEnvelope 逐字节一致。只供旧行（sourceScopesJson 为 NULL）
 * 反推编译 locale，直到 resolver 迁移回填；新行一律用 5 段 computeSourceEnvelope。
 */
function legacyFourSegmentEnvelope(
  content: string | null,
  aliasSetJson: string | null,
  locale: string | null,
  toolchainId: string | null,
): string {
  const hash = createHash('sha256');
  for (const field of [content, aliasSetJson, locale, toolchainId]) {
    const bytes = Buffer.from(field ?? '', 'utf8');
    hash.update(`${bytes.length}:`, 'ascii');
    hash.update(bytes);
    hash.update('|', 'ascii');
  }
  return hash.digest('hex');
}

/**
 * 从 envelope 反推保存时的编译 locale：有封印词汇段时按 5 段重算；旧行（NULL）按 4 段旧格式
 * 与其记录的工具链重算。无 envelope 或都不匹配时返回 undefined。
 */
export function recordedCompileLocale(version: StoredVersionLocaleInput): string | undefined {
  if (!version.sourceEnvelopeSha256) return undefined;
  const { source, aliasSet, sourceToolchainId, sourceScopesJson } = version;
  const envelopeFor = (locale: string) =>
    sourceScopesJson === null
      ? legacyFourSegmentEnvelope(source, aliasSet, locale, sourceToolchainId)
      : computeSourceEnvelope(source, aliasSet, locale, sourceToolchainId, sourceScopesJson);
  return RECORDED_LOCALE_CANDIDATES.find((locale) => envelopeFor(locale) === version.sourceEnvelopeSha256);
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
 */
export function resolveStoredVersionLocale(version: StoredVersionLocaleInput): string {
  const recorded = recordedCompileLocale(version);
  if (!recorded && version.sourceEnvelopeSha256) {
    // 有 envelope 却反推不出（如旧版本保存时用了不受支持的 locale）：只能走兜底链。
    // 旧数据上属预期情形，记 debug 不刷告警。
    console.debug('[policy-version-locale] recorded compile locale not recoverable; falling back');
  }
  return choosePolicyLocale({
    recorded,
    snapshotLocale: uniqueSnapshotLocale(version.vocabularySnapshotIds),
    source: version.source,
    detect: detectCNLLocale,
  });
}
