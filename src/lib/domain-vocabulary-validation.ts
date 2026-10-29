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
  type IdentifierMapping,
  validateVocabulary,
} from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';
// 纯组装逻辑下沉到 domain-vocabulary-assemble.ts（无 Node 依赖），客户端
// editor 与服务端共享同一来源。本文件保留依赖 node:crypto 的 dedup 计算。
import {
  assembleDomainVocabularyFromLinks,
  requiresParent,
  type TermKind,
  type TermLikeRow,
  type AssembleVocabularyOptions,
} from './domain-vocabulary-assemble';
import { VOCAB_FORMAT_MESSAGES, checkVocabularyScope } from './domain-vocabulary-format';

export type VocabularyValidationResult = ReturnType<typeof validateVocabulary>;

// 向后兼容：原从本模块导出的组装 API/类型，转发自纯叶子模块。
export { assembleDomainVocabularyFromLinks, requiresParent };
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

/** 去首尾空白并做 NFC：写法比较的精确口径（与引擎 §6.3 精确匹配一致）。 */
function nfcTrim(value: string): string {
  return value.trim().normalize('NFC');
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/** 同一作用域内同一写法对应多个规范名的冲突（ADR 0051 §8）。 */
export interface VocabularyScopeConflict {
  /** 词汇角色：types / fields / enumMembers / functions。 */
  readonly role: 'types' | 'fields' | 'enumMembers' | 'functions';
  /** fields / enumMembers 的规范父名；types / functions 为空串。 */
  readonly parent: string;
  /** NFC 后的写法。 */
  readonly written: string;
  /** 该写法对应的全部规范名（码点序）。 */
  readonly canonicals: readonly string[];
}

/** 冲突消息前缀：vocabulary-validation-message 据此识别为 scopeConflict 原因码。 */
export const SCOPE_CONFLICT_PREFIX = 'scope conflict:';

type ConflictRole = VocabularyScopeConflict['role'];

/** 词汇各分组对应的解析角色；字段与枚举成员按父名分作用域。 */
const ROLE_GROUPS: ReadonlyArray<{ role: ConflictRole; pick: (v: DomainVocabulary) => readonly IdentifierMapping[] | undefined; scoped: boolean }> = [
  { role: 'types', pick: (v) => v.structs, scoped: false },
  { role: 'fields', pick: (v) => v.fields, scoped: true },
  { role: 'enumMembers', pick: (v) => v.enumValues, scoped: true },
  { role: 'functions', pick: (v) => v.functions, scoped: false },
];

/**
 * 找出同角色、同作用域内 NFC 后写法完全相同却映射到不同规范名的条目（ADR 0051 §8、§14 第 2 条）。
 * 只比较精确写法：仅大小写不同的条目允许并存，使用点由引擎按位置精确优先、折叠唯一再判定。
 * 不同角色（如 `Stufe` 类型与 `stufe` 字段）或不同父结构下的同名字段互不冲突。
 */
export function findVocabularyScopeConflicts(vocab: DomainVocabulary): VocabularyScopeConflict[] {
  const seen = new Map<string, { role: ConflictRole; parent: string; written: string; canonicals: Set<string> }>();
  for (const group of ROLE_GROUPS) {
    for (const mapping of group.pick(vocab) ?? []) {
      const parent = group.scoped ? (mapping.parent ?? '') : '';
      for (const raw of [mapping.localized, ...(mapping.aliases ?? [])]) {
        const written = raw.normalize('NFC');
        const key = JSON.stringify([group.role, parent, written]);
        const entry = seen.get(key) ?? { role: group.role, parent, written, canonicals: new Set<string>() };
        entry.canonicals.add(mapping.canonical);
        seen.set(key, entry);
      }
    }
  }
  return [...seen.values()]
    .filter((e) => e.canonicals.size > 1)
    .map((e) => ({ role: e.role, parent: e.parent, written: e.written, canonicals: [...e.canonicals].sort() }));
}

const ROLE_BY_KIND: Readonly<Record<string, ConflictRole>> = {
  struct: 'types',
  field: 'fields',
  enum_value: 'enumMembers',
  function: 'functions',
};

/**
 * 保存单条词条前的作用域冲突：只报告与候选词条写法相关的冲突，存量数据里与它无关的旧冲突
 * 不阻断本次保存。existing 为同一 (domain, locale) 分组内的其它活跃词条（不含候选自身）。
 */
export function findTermScopeConflicts(
  existing: readonly TermLikeRow[],
  candidate: TermLikeRow,
): VocabularyScopeConflict[] {
  const role = ROLE_BY_KIND[candidate.kind];
  const parent = role === 'fields' || role === 'enumMembers' ? (candidate.parentCanonical ?? '') : '';
  const written = new Set([candidate.localized, ...(candidate.aliases ?? [])].map((w) => w.normalize('NFC')));
  const vocab = assembleDomainVocabularyFromLinks([...existing, candidate], {
    domain: candidate.domain,
    locale: candidate.locale,
  });
  return findVocabularyScopeConflicts(vocab).filter(
    (c) => c.role === role && c.parent === parent && written.has(c.written),
  );
}

/** 冲突的诊断消息（英文、稳定格式，界面经原因码本地化，不展示原文）。 */
export function formatScopeConflict(conflict: VocabularyScopeConflict): string {
  const scope = conflict.parent ? `${conflict.role}[${conflict.parent}]` : conflict.role;
  return `${SCOPE_CONFLICT_PREFIX} "${conflict.written}" maps to ${conflict.canonicals.join(', ')} in ${scope}`;
}

/**
 * 词汇校验：引擎 validateVocabulary 已按 ADR 0051 判定（规范名格式、字面量宏、字段 / 枚举成员须有
 * parent、同角色同作用域写法冲突），这里直接复用，保证与编辑器、注册表同一口径。
 */
export function validateDomainVocabulary(vocab: DomainVocabulary): VocabularyValidationResult {
  return validateVocabulary(vocab);
}

/**
 * 规范化用户输入并计算全局 DomainTerm 去重键所用的列。
 * - canonical / parent 的 norm 列为 lower(trim(...))：规范名是 ASCII 标识符，大小写不区分词条。
 * - localized 的 norm 列为 NFC(trim(...))，**不折叠大小写**：仅大小写不同的写法是不同词条
 *   （ADR 0051 §14 第 2 条，如 Alter / alter），去重不得把其中一个吞掉；大小写折叠只用于
 *   按角色 / 作用域的冲突判定（findVocabularyScopeConflicts）。
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
    localized: nfcTrim(input.localized),
    localizedNorm: nfcTrim(input.localized),
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
