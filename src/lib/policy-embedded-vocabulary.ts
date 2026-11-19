/**
 * 策略内嵌词汇（ADR 0060 §6）：写在版本行 `PolicyVersion.embeddedVocabulary` 上、随策略评审的少量词条，
 * 含个人 / 团队词汇没有的字面量宏（literal）。纯叶子模块，浏览器安全（不引入 node:* 与数据库）。
 *
 * - 格式与确定性序列化（§6.1）：同一内容只有一种字节表示，存为 text，NULL = 无内嵌词条；
 * - 保存时校验（§6.4）：too_large → duplicate → invalid（引擎 validateVocabulary）→ shadows_keyword；
 * - 合并（§6.3）：内嵌 > 团队 > 作者。下层词条只要有一个写法与内嵌词条同角色键而规范名不同，
 *   或一方是字面量触发词，就整条丢弃并回报；角色键与团队合并同一口径（domain-vocabulary-team-merge）。
 *
 * 读路径只经 {@link withEmbeddedVocabulary}（由 execution-input、审批冻结与 resolver 迁移调用）：
 * 无内嵌词条时原样返回下层词汇对象，旧版本的编译输入与 envelope 因而逐字节不变。
 */

import {
  IdentifierKind,
  validateVocabulary,
  type DomainVocabulary,
  type IdentifierMapping,
} from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';
import { extractReservedAliasSets, getLexicon } from '@/lib/aster-lexicon';
import { mergeVocabularies } from '@/lib/domain-vocabulary-scope';
import { writtenKeys, type WrittenKeyRow } from '@/lib/domain-vocabulary-team-merge';
import { normalizeAliasToken, type AliasSet } from '@/lib/policy-alias-shared';

export type EmbeddedTermKind = 'struct' | 'field' | 'function' | 'enum_value' | 'literal';

export interface EmbeddedTerm {
  kind: EmbeddedTermKind;
  /** 源码里的写法（触发词）。 */
  localized: string;
  /** 规范名；literal 为展开的字符串内容（不含引号）。 */
  canonical: string;
  /** field / enum_value 必填（所属结构体 / 枚举的规范名），其余种类禁止。 */
  parent?: string;
}

export interface EmbeddedVocabulary {
  v: 1;
  terms: EmbeddedTerm[];
}

export const EMBEDDED_VOCABULARY_LIMITS = {
  maxTerms: 32,
  maxLocalized: 32,
  maxCanonical: 64,
  maxLiteral: 256,
  /** 与 DB CHECK `octet_length("embeddedVocabulary") <= 8192` 同值。 */
  maxBytes: 8192,
} as const;

export type EmbeddedVocabularyErrorCode =
  | 'embedded_vocabulary_invalid_format'
  | 'embedded_vocabulary_too_large'
  | 'embedded_vocabulary_invalid'
  | 'embedded_vocabulary_duplicate'
  | 'embedded_vocabulary_shadows_keyword';

/** 内嵌词汇不合法。保存路径映射为 400 `{ error, code, detail }`；读路径不退化，由调用方 fail-closed。 */
export class EmbeddedVocabularyError extends Error {
  readonly code: EmbeddedVocabularyErrorCode;
  readonly detail?: string;

  constructor(code: EmbeddedVocabularyErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'EmbeddedVocabularyError';
    this.code = code;
    this.detail = detail;
  }
}

/** 合并时被内嵌词条遮蔽、整条不生效的下层词条（保存响应 `vocabularyShadowed` 的元素）。 */
export interface ShadowedTerm {
  kind: string;
  localized: string;
  canonical: string;
  source: 'team' | 'author';
}

export interface EmbeddedMergeResult {
  vocabulary: DomainVocabulary | null;
  shadowed: ShadowedTerm[];
}

/** 引擎形状里的固定 id / name（ADR 0060 §6.1）。 */
export const EMBEDDED_VOCABULARY_ID = 'policy.embedded';

const KINDS: ReadonlySet<string> = new Set<EmbeddedTermKind>(['struct', 'field', 'function', 'enum_value', 'literal']);
const TERM_KEYS: ReadonlySet<string> = new Set(['kind', 'localized', 'canonical', 'parent']);

function needsParent(kind: EmbeddedTermKind): boolean {
  return kind === 'field' || kind === 'enum_value';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatError(detail: string): EmbeddedVocabularyError {
  return new EmbeddedVocabularyError('embedded_vocabulary_invalid_format', detail);
}

function parseTerm(raw: unknown, index: number): EmbeddedTerm {
  const at = `terms[${index}]`;
  if (!isPlainObject(raw)) throw formatError(`${at} must be an object`);
  const unknownKey = Object.keys(raw).find((key) => !TERM_KEYS.has(key));
  if (unknownKey !== undefined) throw formatError(`${at} has unknown key "${unknownKey}"`);
  const { kind, localized, canonical, parent } = raw;
  if (typeof kind !== 'string' || !KINDS.has(kind)) throw formatError(`${at}.kind is not a known kind`);
  if (typeof localized !== 'string') throw formatError(`${at}.localized must be a string`);
  if (typeof canonical !== 'string') throw formatError(`${at}.canonical must be a string`);
  const termKind = kind as EmbeddedTermKind;
  if (needsParent(termKind) && typeof parent !== 'string') throw formatError(`${at}.parent is required for ${kind}`);
  if (!needsParent(termKind) && 'parent' in raw) throw formatError(`${at}.parent is not allowed for ${kind}`);
  return needsParent(termKind)
    ? { kind: termKind, localized, canonical, parent: parent as string }
    : { kind: termKind, localized, canonical };
}

/** 按 §6.1 解析请求体或已存文本解出的值；形状不符抛 `embedded_vocabulary_invalid_format`。 */
export function parseEmbeddedVocabulary(input: unknown): EmbeddedVocabulary {
  if (!isPlainObject(input)) throw formatError('embedded vocabulary must be an object');
  const unknownKey = Object.keys(input).find((key) => key !== 'v' && key !== 'terms');
  if (unknownKey !== undefined) throw formatError(`unknown key "${unknownKey}"`);
  if (input.v !== 1) throw formatError('v must be 1');
  if (!Array.isArray(input.terms)) throw formatError('terms must be an array');
  return { v: 1, terms: input.terms.map(parseTerm) };
}

function nfcTerm(term: EmbeddedTerm): EmbeddedTerm {
  const base = { kind: term.kind, localized: term.localized.normalize('NFC'), canonical: term.canonical.normalize('NFC') };
  return term.parent === undefined ? base : { ...base, parent: term.parent.normalize('NFC') };
}

/** 码点序比较（不是 UTF-16 码元序：增补平面字符与 U+E000–U+FFFF 的先后与 Java / 规范一致）。 */
function compareCodePoints(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const diff = left[i]!.codePointAt(0)! - right[i]!.codePointAt(0)!;
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

function compareTerms(a: EmbeddedTerm, b: EmbeddedTerm): number {
  return compareCodePoints(a.kind, b.kind)
    || compareCodePoints(a.localized, b.localized)
    || compareCodePoints(a.parent ?? '', b.parent ?? '')
    // 只为重复词条（保存时被拒）也给出确定顺序
    || compareCodePoints(a.canonical, b.canonical);
}

/** NFC 后按 (kind, localized, parent) 码点序排列的词条：序列化、校验与引擎形状共用。 */
function normalizedTerms(ev: EmbeddedVocabulary): EmbeddedTerm[] {
  return ev.terms.map(nfcTerm).sort(compareTerms);
}

/**
 * 确定性序列化：NFC、码点序排序、键序固定 `kind, localized, canonical, parent`、无空白；
 * 无词条返回 null（存 NULL）。
 */
export function serializeEmbeddedVocabulary(ev: EmbeddedVocabulary): string | null {
  if (ev.terms.length === 0) return null;
  const terms = normalizedTerms(ev).map((term) => (term.parent === undefined
    ? { kind: term.kind, localized: term.localized, canonical: term.canonical }
    : { kind: term.kind, localized: term.localized, canonical: term.canonical, parent: term.parent }));
  return JSON.stringify({ v: 1, terms });
}

function toMapping(term: EmbeddedTerm): IdentifierMapping {
  return {
    canonical: term.canonical,
    localized: term.localized,
    kind: term.kind as IdentifierKind,
    ...(term.parent === undefined ? {} : { parent: term.parent }),
  };
}

/** 转换为引擎的 DomainVocabulary（§6.1）。 */
export function toDomainVocabulary(ev: EmbeddedVocabulary, locale: string): DomainVocabulary {
  const terms = normalizedTerms(ev);
  const of = (kind: EmbeddedTermKind) => terms.filter((term) => term.kind === kind).map(toMapping);
  return {
    id: EMBEDDED_VOCABULARY_ID,
    name: 'policy',
    locale,
    version: '1',
    structs: of('struct'),
    fields: of('field'),
    functions: of('function'),
    enumValues: of('enum_value'),
    literals: of('literal'),
  };
}

function codePointLength(text: string): number {
  return [...text].length;
}

function tooLarge(detail: string): EmbeddedVocabularyError {
  return new EmbeddedVocabularyError('embedded_vocabulary_too_large', detail);
}

function checkLimits(ev: EmbeddedVocabulary): void {
  const limits = EMBEDDED_VOCABULARY_LIMITS;
  if (ev.terms.length > limits.maxTerms) throw tooLarge(`at most ${limits.maxTerms} terms`);
  for (const term of ev.terms.map(nfcTerm)) {
    if (codePointLength(term.localized) > limits.maxLocalized) {
      throw tooLarge(`"${term.localized}" is longer than ${limits.maxLocalized} characters`);
    }
    const max = term.kind === 'literal' ? limits.maxLiteral : limits.maxCanonical;
    if (codePointLength(term.canonical) > max) throw tooLarge(`canonical of "${term.localized}" is longer than ${max} characters`);
    if (term.parent !== undefined && codePointLength(term.parent) > limits.maxCanonical) {
      throw tooLarge(`parent of "${term.localized}" is longer than ${limits.maxCanonical} characters`);
    }
  }
  const serialized = serializeEmbeddedVocabulary(ev) ?? '';
  if (new TextEncoder().encode(serialized).length > limits.maxBytes) {
    throw tooLarge(`serialized form exceeds ${limits.maxBytes} bytes`);
  }
}

/** 字面量触发词的折叠键：与引擎 validateVocabulary 的触发词唯一性同口径（NFC + toLowerCase）。 */
function triggerKey(written: string): string {
  return written.normalize('NFC').toLowerCase();
}

function mappingForms(mapping: IdentifierMapping): string[] {
  return [mapping.localized, ...(mapping.aliases ?? [])];
}

function keyRow(mapping: IdentifierMapping, locale: string): WrittenKeyRow {
  return {
    kind: mapping.kind,
    locale,
    localized: mapping.localized,
    aliases: mapping.aliases ?? null,
    parentCanonical: mapping.parent ?? null,
  };
}

function checkDuplicates(ev: EmbeddedVocabulary, locale: string): void {
  const roleKeys = new Set<string>();
  const triggers = new Map<string, boolean>(); // 折叠写法 → 是否已有字面量占用
  for (const term of normalizedTerms(ev)) {
    for (const key of writtenKeys(keyRow(toMapping(term), locale))) {
      if (roleKeys.has(key)) throw new EmbeddedVocabularyError('embedded_vocabulary_duplicate', `"${term.localized}" is defined twice for the same role`);
      roleKeys.add(key);
    }
    const isLiteral = term.kind === 'literal';
    const key = triggerKey(term.localized);
    const previous = triggers.get(key);
    if (previous !== undefined && (previous || isLiteral)) {
      throw new EmbeddedVocabularyError('embedded_vocabulary_duplicate', `literal trigger "${term.localized}" is used twice`);
    }
    triggers.set(key, (previous ?? false) || isLiteral);
  }
}

function checkEngine(ev: EmbeddedVocabulary, locale: string): void {
  const empty = ev.terms.find((term) => term.localized.trim() === '');
  if (empty) throw new EmbeddedVocabularyError('embedded_vocabulary_invalid', 'localized must not be empty');
  const result = validateVocabulary(toDomainVocabulary(ev, locale));
  if (!result.valid) throw new EmbeddedVocabularyError('embedded_vocabulary_invalid', result.errors.join('; '));
}

function checkKeywords(ev: EmbeddedVocabulary, ctx: { locale: string; aliasSet: AliasSet | null }): void {
  const { canonicalKeywordsLower, baseAliasesLower } = extractReservedAliasSets(getLexicon(ctx.locale));
  const versionAliases = new Set(
    Object.values(ctx.aliasSet ?? {}).flatMap((aliases) => aliases.map((alias) => normalizeAliasToken(alias.normalize('NFC')))),
  );
  for (const term of ev.terms.map(nfcTerm)) {
    const written = normalizeAliasToken(term.localized);
    if (canonicalKeywordsLower.has(written) || baseAliasesLower.has(written) || versionAliases.has(written)) {
      throw new EmbeddedVocabularyError('embedded_vocabulary_shadows_keyword', `"${term.localized}" is a keyword or keyword alias`);
    }
  }
}

/** 保存时校验（§6.4），按 too_large → duplicate → invalid → shadows_keyword 的顺序报第一个问题。 */
export function validateEmbeddedVocabulary(
  ev: EmbeddedVocabulary,
  ctx: { locale: string; aliasSet: AliasSet | null },
): void {
  checkLimits(ev);
  checkDuplicates(ev, ctx.locale);
  checkEngine(ev, ctx.locale);
  checkKeywords(ev, ctx);
}

/** 词汇里全部角色（含字面量）的映射，按 structs、fields、functions、enumValues、literals 的顺序。 */
export function allMappings(vocabulary: DomainVocabulary): IdentifierMapping[] {
  return [
    ...(vocabulary.structs ?? []),
    ...(vocabulary.fields ?? []),
    ...(vocabulary.functions ?? []),
    ...(vocabulary.enumValues ?? []),
    ...(vocabulary.literals ?? []),
  ];
}

const isLiteralMapping = (mapping: IdentifierMapping) => mapping.kind === IdentifierKind.LITERAL;

/** 内嵌词条的占用索引：角色键 → 规范名集合；字面量触发词 → 展开内容；全部触发词。 */
interface EmbeddedIndex {
  roleCanonicals: Map<string, Set<string>>;
  literalContents: Map<string, string>;
  triggers: Set<string>;
}

function indexEmbedded(embedded: DomainVocabulary): EmbeddedIndex {
  const index: EmbeddedIndex = { roleCanonicals: new Map(), literalContents: new Map(), triggers: new Set() };
  for (const mapping of allMappings(embedded)) {
    for (const key of writtenKeys(keyRow(mapping, embedded.locale))) {
      index.roleCanonicals.set(key, (index.roleCanonicals.get(key) ?? new Set()).add(mapping.canonical));
    }
    for (const form of mappingForms(mapping)) {
      index.triggers.add(triggerKey(form));
      if (isLiteralMapping(mapping)) index.literalContents.set(triggerKey(form), mapping.canonical);
    }
  }
  return index;
}

/**
 * 下层词条是否被内嵌词条遮蔽：同角色键而规范名不同；或写法撞内嵌字面量触发词；
 * 或它本身是字面量而触发词撞任一内嵌写法。与内嵌字面量完全相同的字面量视为同一词条（去重，不回报）。
 */
function isShadowed(mapping: IdentifierMapping, locale: string, index: EmbeddedIndex): boolean {
  const roleConflict = writtenKeys(keyRow(mapping, locale)).some((key) => {
    const canonicals = index.roleCanonicals.get(key);
    return canonicals !== undefined && [...canonicals].some((canonical) => canonical !== mapping.canonical);
  });
  if (roleConflict) return true;
  return mappingForms(mapping).some((form) => {
    const key = triggerKey(form);
    const literal = index.literalContents.get(key);
    if (isLiteralMapping(mapping)) return index.triggers.has(key) && literal !== mapping.canonical;
    return literal !== undefined;
  });
}

function withoutShadowed(lower: DomainVocabulary, keep: (mapping: IdentifierMapping) => boolean): DomainVocabulary {
  const literals = (lower.literals ?? []).filter(keep);
  return {
    ...lower,
    structs: lower.structs.filter(keep),
    fields: lower.fields.filter(keep),
    functions: lower.functions.filter(keep),
    ...(lower.enumValues ? { enumValues: lower.enumValues.filter(keep) } : {}),
    ...(lower.literals ? { literals } : {}),
  };
}

function hasMappings(vocabulary: DomainVocabulary | null | undefined): vocabulary is DomainVocabulary {
  return !!vocabulary && allMappings(vocabulary).length > 0;
}

/**
 * 内嵌词汇与下层（团队 + 作者）有效词汇合并，内嵌优先（§6.3）。
 * `sources` 标注下层词条来自团队还是作者（保存路径给出）；未标注的按作者回报。
 * 无内嵌词条时原样返回 `lower`（同一对象）。合并结果的 locale 取内嵌词汇的 locale（即策略编译 locale）。
 */
export function mergeEmbeddedVocabulary(
  embedded: DomainVocabulary | null,
  lower: DomainVocabulary | null,
  sources?: Map<IdentifierMapping, 'team' | 'author'>,
): EmbeddedMergeResult {
  if (!hasMappings(embedded)) return { vocabulary: lower, shadowed: [] };
  if (!lower) return { vocabulary: embedded, shadowed: [] };
  const index = indexEmbedded(embedded);
  const shadowed: ShadowedTerm[] = [];
  const kept = withoutShadowed(lower, (mapping) => {
    if (!isShadowed(mapping, lower.locale, index)) return true;
    shadowed.push({
      kind: mapping.kind,
      localized: mapping.localized,
      canonical: mapping.canonical,
      source: sources?.get(mapping) ?? 'author',
    });
    return false;
  });
  return { vocabulary: mergeVocabularies([embedded, kept], { locale: embedded.locale }), shadowed };
}

/**
 * 读路径：解析版本行上已存的内嵌词汇文本并与下层词汇合并。文本为空（NULL）时原样返回 `lower`。
 * 已存文本必须是可解析的规范序列化（与建版本时写入的字节相同），否则抛 {@link EmbeddedVocabularyError}，
 * 不退化为无内嵌词汇——退化会改变策略含义。
 */
export function withEmbeddedVocabulary(
  lower: DomainVocabulary | null,
  embeddedText: string | null | undefined,
  locale: string,
): DomainVocabulary | null {
  const ev = parseStoredEmbeddedVocabulary(embeddedText);
  if (!ev) return lower;
  return mergeEmbeddedVocabulary(toDomainVocabulary(ev, locale), lower).vocabulary;
}

/**
 * 解析版本行上已存的内嵌词汇文本；NULL → null（空串视为损坏）。文本必须是可解析的规范序列化
 * （与建版本时写入的字节相同），否则抛 `embedded_vocabulary_invalid_format`。
 * 读路径与 PUT 省略字段时的沿用共用此口径。
 */
export function parseStoredEmbeddedVocabulary(embeddedText: string | null | undefined): EmbeddedVocabulary | null {
  // 只有 NULL 表示无内嵌词条；空串不是任何规范序列化，按损坏文本 fail-closed（解析失败）
  if (embeddedText === null || embeddedText === undefined) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(embeddedText);
  } catch {
    throw formatError('stored embedded vocabulary is not valid JSON');
  }
  const ev = parseEmbeddedVocabulary(raw);
  if (serializeEmbeddedVocabulary(ev) !== embeddedText) {
    throw formatError('stored embedded vocabulary is not in canonical form');
  }
  return ev;
}

/**
 * 保存入口请求体的 `embeddedVocabulary` 字段（§6.5）：`undefined` / `null` → null（无内嵌词条），
 * 对象 → 按 §6.1 解析（形状不符抛 `embedded_vocabulary_invalid_format`）。
 * PUT 的「省略即沿用」由路由在调用前判定，不在这里处理。
 */
export function parseEmbeddedVocabularyField(input: unknown): EmbeddedVocabulary | null {
  return input === undefined || input === null ? null : parseEmbeddedVocabulary(input);
}

/** 内嵌词汇（可为 null）的存储形态：null 或无词条 → null，其余为确定性序列化。 */
export function storedEmbeddedVocabulary(ev: EmbeddedVocabulary | null | undefined): string | null {
  return ev ? serializeEmbeddedVocabulary(ev) : null;
}
