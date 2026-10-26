/**
 * Domain vocabulary 适配层
 *
 * 把 user_domain_term 行翻译成 aster-lang-ts 的 DomainVocabulary，
 * 调用上游的 validateVocabulary 做规范化校验，
 * 并计算 DomainTerm 表的 dedup 键。
 *
 * 不直接接触数据库——纯函数 + 类型。
 */

import { createHash } from 'node:crypto';
import {
  type DomainVocabulary,
  validateVocabulary,
} from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';
// 纯组装逻辑下沉到 domain-vocabulary-assemble.ts（无 Node 依赖），客户端
// editor 与服务端共享同一来源。本文件保留依赖 node:crypto 的 dedup 计算。
import {
  assembleDomainVocabularyFromLinks,
  type TermKind,
  type TermLikeRow,
  type AssembleVocabularyOptions,
} from './domain-vocabulary-assemble';
import { VOCAB_FORMAT_MESSAGES, checkVocabularyScope } from './domain-vocabulary-format';

export type VocabularyValidationResult = ReturnType<typeof validateVocabulary>;

// 向后兼容：原从本模块导出的组装 API/类型，转发自纯叶子模块。
export { assembleDomainVocabularyFromLinks };
export type { TermKind, TermLikeRow, AssembleVocabularyOptions };

export interface NormalizedTermInput {
  domain: string;
  locale: string;
  kind: TermKind;
  canonical: string;
  canonicalNorm: string;
  localized: string;
  localizedNorm: string;
  parentCanonical?: string;
  parentCanonicalNorm: string;
  description?: string;
  aliases: string[];
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/** Validate a DomainVocabulary using the shared aster-lang-ts validator. */
export function validateDomainVocabulary(vocab: DomainVocabulary): VocabularyValidationResult {
  return validateVocabulary(vocab);
}

/**
 * Normalize user-facing input and compute the columns used by the global
 * DomainTerm dedup key. The norm columns are lower(trim(...)) so the dedup
 * key is stable across whitespace and case.
 */
export function normalizeTermInput(input: {
  domain: string;
  locale: string;
  kind: TermKind;
  canonical: string;
  localized: string;
  parentCanonical?: string;
  description?: string;
  aliases?: string[];
}): NormalizedTermInput {
  return {
    domain: input.domain.trim(),
    locale: input.locale.trim(),
    kind: input.kind,
    canonical: input.canonical.trim(),
    canonicalNorm: normalizeText(input.canonical),
    localized: input.localized.trim(),
    localizedNorm: normalizeText(input.localized),
    parentCanonical: input.parentCanonical?.trim() || undefined,
    parentCanonicalNorm: normalizeText(input.parentCanonical),
    description: input.description?.trim() || undefined,
    aliases: (input.aliases ?? []).map((a) => a.trim()).filter(Boolean),
  };
}

/** Compute the stable global DomainTerm deduplication key. */
export function computeDedupKey(input: {
  domain: string;
  locale: string;
  kind: string;
  canonicalNorm: string;
  localizedNorm: string;
  parentCanonicalNorm?: string | null;
}): string {
  const json = canonicalJson({
    domain: input.domain,
    locale: input.locale,
    kind: input.kind,
    canonicalNorm: input.canonicalNorm,
    localizedNorm: input.localizedNorm,
    parentCanonicalNorm: input.parentCanonicalNorm ?? '',
  });
  return createHash('sha256').update(json).digest('hex');
}

/**
 * 对已规范化的输入执行 domain / locale 格式校验（#612），并把 locale 换成
 * BCP-47 规范大小写。必须在计算 dedup 键之前调用，否则 `zh-cn` 与 `zh-CN`
 * 会落成两个全局 DomainTerm。
 */
export function applyVocabularyScopeFormat(
  normalized: NormalizedTermInput,
): { ok: true; value: NormalizedTermInput } | { ok: false; message: string } {
  const scope = checkVocabularyScope(normalized);
  if (scope.issues.length > 0) {
    return { ok: false, message: scope.issues.map((i) => VOCAB_FORMAT_MESSAGES[i]).join('; ') };
  }
  return { ok: true, value: { ...normalized, domain: scope.domain, locale: scope.locale } };
}
