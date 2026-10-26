/**
 * 从策略源码提取输入映射所需的类型信息（#626、#638）。
 *
 * 编译口径与执行端一致：同一 locale 的 CNL lexicon（并入冻结的关键词别名）+ 同一份领域词汇
 * （已审批版本 = 冻结快照，草稿 = 作者现行词汇，由调用方传入）。带词汇编译时，引擎看到的结构 /
 * 字段 / 枚举名是规范名；映射器的约定是「策略写法」（作者所写、经引擎规范化后得到规范名），
 * 所以这里把规范名按词汇还原为策略写法（{@link relocalizeTypes}），映射器两种名字都能拿到。
 *
 * 类型只取决于声明与函数签名，与函数体无关：完整编译失败时（如 TS 解析器尚不支持、而执行端
 * 支持的函数体写法），把每个 Rule 的函数体换成占位语句后再解析一次（{@link stubFunctionBodies}）。
 * 两次都失败才返回 null——调用方据此拒绝执行（不能在未映射的输入上执行）。
 *
 * 编译结果按（源码, locale, 别名集, 词汇内容）缓存在 isolate 内（LRU）：已发布版本的源码与冻结
 * 快照不可变；草稿源码或作者词汇一改，键就变，不会读到旧结果。入口函数按请求再选，不进缓存键。
 */

import { createHash } from 'node:crypto';
import {
  canonicalize,
  compile,
  createKeywordTranslator,
  KW,
  lex,
  lowerModule,
  needsKeywordTranslation,
  parse,
  TokenKind,
  vocabularyRegistry,
} from '@aster-cloud/aster-lang-ts/browser';
import { IdentifierKind, type DomainVocabulary } from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';
import { getLexicon, type Lexicon } from '@/lib/aster-lexicon';
import { engineName, mappingsOf, type PolicyDataDecl, type PolicyEnumDecl, type PolicyInputTypes, type PolicyTypeNode, type VocabularyNameIndex } from './mapper';

interface CoreDecl {
  kind: string;
  name: string;
  fields?: Array<{ name: string; type: PolicyTypeNode }>;
  variants?: string[];
  params?: Array<{ name: string; type: PolicyTypeNode }>;
  ret?: PolicyTypeNode;
}

interface CompiledTypes {
  readonly funcs: readonly CoreDecl[];
  readonly decls: ReadonlyArray<PolicyDataDecl | PolicyEnumDecl>;
}

type NameNormalizer = (name: string) => string;
type AliasSet = Record<string, readonly string[]> | null | undefined;

/** 一次类型提取的输入：与执行端同一份源码、语言、别名与词汇。 */
export interface PolicyTypeSource {
  readonly source: string;
  readonly locale: string;
  /** 版本冻结的关键词别名（只用于解析源码，不参与输入映射）。 */
  readonly aliasSet: AliasSet;
  /** 执行用的领域词汇（与透传给引擎的同一份）；缺省表示不带词汇编译。 */
  readonly vocabulary?: Record<string, unknown>;
  /** 由同一份词汇建的名字索引，用于把规范名还原为策略写法；带词汇时必须提供。 */
  readonly index?: VocabularyNameIndex | null;
}

/** 每个 isolate 最多缓存的版本数；单条只含声明骨架，体积很小。 */
const CACHE_LIMIT = 256;
const cache = new Map<string, CompiledTypes | null>();

/** 编译期临时注册词汇用的租户前缀：与编辑器 / demo 的注册键互不相干。 */
const REGISTRY_TENANT_PREFIX = 'execution-input-types';

/** 词汇缺 id 时的注册域名（与 domain-vocabulary-scope 合并词汇的默认 id 同口径）。 */
const FALLBACK_VOCABULARY_DOMAIN = 'user-vocabulary';

function lexiconWithAliases(locale: string, aliasSet: AliasSet): Lexicon {
  const base = getLexicon(locale);
  if (!aliasSet || Object.keys(aliasSet).length === 0) return base;
  const baseAliases = (base as { aliases?: Record<string, readonly string[]> }).aliases ?? {};
  return { ...base, aliases: { ...baseAliases, ...aliasSet } } as Lexicon;
}

function toTypeDecl(decl: CoreDecl): PolicyDataDecl | PolicyEnumDecl | null {
  if (decl.kind === 'Data') return { kind: 'Data', name: decl.name, fields: decl.fields ?? [] };
  if (decl.kind === 'Enum') return { kind: 'Enum', name: decl.name, variants: decl.variants ?? [] };
  return null;
}

function sha256(...parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\0');
  return hash.digest('hex');
}

/** 词汇内容身份：快照与现行词汇都按内容区分，词条一改即换键。 */
function vocabularyIdentity(vocabulary: Record<string, unknown> | undefined): string {
  return vocabulary ? sha256(JSON.stringify(vocabulary)) : '';
}

function cacheKey(input: PolicyTypeSource): string {
  const aliases = input.aliasSet ? JSON.stringify(Object.entries(input.aliasSet).sort(([a], [b]) => a.localeCompare(b))) : '';
  return sha256(input.locale, aliases, vocabularyIdentity(input.vocabulary), input.source);
}

/* ---------------------------------------------------------------- 编译 */

/** 规范化选项：带词汇时启用领域标识符翻译（与执行端同一份词汇）。 */
type CanonicalizeTarget = { lexicon: Lexicon; domain?: string; tenantId?: string };

/** 词条数组键与其类别：快照 JSON 可能缺数组或缺条目的 kind，注册前按所在数组补齐（与映射器同口径）。 */
const VOCABULARY_ARRAYS: ReadonlyArray<[string, IdentifierKind]> = [
  ['structs', IdentifierKind.STRUCT],
  ['fields', IdentifierKind.FIELD],
  ['functions', IdentifierKind.FUNCTION],
  ['enumValues', IdentifierKind.ENUM_VALUE],
  ['literals', IdentifierKind.LITERAL],
];

function registrableVocabulary(vocabulary: Record<string, unknown>, domain: string, locale: string): DomainVocabulary {
  const arrays = Object.fromEntries(VOCABULARY_ARRAYS.map(([key, kind]) => [key, mappingsOf(vocabulary[key], kind)]));
  return { ...vocabulary, ...arrays, id: domain, locale } as unknown as DomainVocabulary;
}

/**
 * 在临时注册的词汇下运行 fn（编译是同步的，注册 → 编译 → 撤销之间不会插入别的请求）。
 * 词汇 locale 对齐 lexicon id，保证注册键与规范化查找键一致。
 */
function withVocabulary<T>(lexicon: Lexicon, vocabulary: Record<string, unknown> | undefined, fn: (target: CanonicalizeTarget) => T): T {
  if (!vocabulary) return fn({ lexicon });
  const domain = typeof vocabulary.id === 'string' && vocabulary.id ? vocabulary.id : FALLBACK_VOCABULARY_DOMAIN;
  const tenantId = `${REGISTRY_TENANT_PREFIX}:${vocabularyIdentity(vocabulary)}`;
  vocabularyRegistry.registerCustom(tenantId, registrableVocabulary(vocabulary, domain, lexicon.id));
  try {
    return fn({ lexicon, domain, tenantId });
  } finally {
    vocabularyRegistry.unregisterCustom(tenantId, domain, lexicon.id);
  }
}

type DeclResult = { decls: CoreDecl[] } | { errors: unknown };

/** 完整编译（与编辑器 / 执行同一管线）。 */
function compileDecls(source: string, target: CanonicalizeTarget): DeclResult {
  const result = compile(source, target as Parameters<typeof compile>[1]) as {
    success?: boolean;
    core?: { decls?: CoreDecl[] };
    parseErrors?: unknown;
    errors?: unknown;
  };
  const decls = result.core?.decls ?? [];
  if (result.success === false || decls.length === 0) return { errors: result.parseErrors ?? result.errors ?? 'no declarations' };
  return { decls };
}

type Token = { kind: string; value: unknown; start: unknown; end: unknown };

function lowerOf(token: Token | undefined): string {
  return typeof token?.value === 'string' ? token.value.toLowerCase() : '';
}

/** 从 INDENT 下标找配对的 DEDENT 下标；没有则返回 -1。 */
function matchingDedent(tokens: readonly Token[], indentAt: number): number {
  let depth = 0;
  for (let i = indentAt; i < tokens.length; i++) {
    if (tokens[i]!.kind === TokenKind.INDENT) depth++;
    if (tokens[i]!.kind === TokenKind.DEDENT && --depth === 0) return i;
  }
  return -1;
}

/** Rule 头之后第一个「: 换行 缩进」的 INDENT 下标；遇到下一条顶层声明前没找到则返回 -1。 */
function bodyIndentAfter(tokens: readonly Token[], ruleAt: number): number {
  for (let i = ruleAt + 1; i + 2 < tokens.length; i++) {
    if (tokens[i]!.kind === TokenKind.INDENT || lowerOf(tokens[i]) === KW.RULE) return -1;
    const opensBody = tokens[i]!.kind === TokenKind.COLON && tokens[i + 1]!.kind === TokenKind.NEWLINE;
    if (opensBody && tokens[i + 2]!.kind === TokenKind.INDENT) return i + 2;
  }
  return -1;
}

/** 占位函数体 `Return 0.`：不做类型检查，任何返回类型都能解析。 */
function stubBody(at: Token): Token[] {
  const span = { start: at.start, end: at.start };
  return [
    { kind: TokenKind.IDENT, value: KW.RETURN, ...span },
    { kind: TokenKind.INT, value: 0, ...span },
    { kind: TokenKind.DOT, value: '.', ...span },
    { kind: TokenKind.NEWLINE, value: null, ...span },
  ];
}

/**
 * 把每个顶层 Rule 的函数体换成占位语句（保留 INDENT / DEDENT），只留下声明与签名。
 * 只处理顶层（缩进深度 0）的 Rule；签名跨行等认不出的形状保持原样。
 */
function stubFunctionBodies(tokens: readonly Token[]): Token[] {
  const out: Token[] = [];
  let depth = 0;
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    const indentAt = depth === 0 && lowerOf(token) === KW.RULE ? bodyIndentAfter(tokens, i) : -1;
    const dedentAt = indentAt >= 0 ? matchingDedent(tokens, indentAt) : -1;
    if (dedentAt < 0) {
      if (token.kind === TokenKind.INDENT) depth++;
      if (token.kind === TokenKind.DEDENT) depth--;
      out.push(token);
      i++;
      continue;
    }
    out.push(...tokens.slice(i, indentAt + 1), ...stubBody(tokens[indentAt]!), tokens[dedentAt]!);
    i = dedentAt + 1;
  }
  return out;
}

/** 只解析声明与签名（函数体换成占位语句），仍有语法错误则失败。 */
function signatureDecls(source: string, target: CanonicalizeTarget): DeclResult {
  const { lexicon, domain, tenantId } = target;
  const canonical = domain
    ? canonicalize(source, { lexicon, domain, locale: lexicon.id, tenantId })
    : canonicalize(source, lexicon);
  let tokens = lex(canonical, lexicon) as unknown as Token[];
  if (needsKeywordTranslation(lexicon)) {
    tokens = createKeywordTranslator(lexicon).translateTokens(tokens as never) as unknown as Token[];
  }
  const parsed = parse(stubFunctionBodies(tokens) as never, lexicon) as {
    ast?: unknown;
    diagnostics?: Array<{ severity?: string }>;
  };
  const errors = (parsed.diagnostics ?? []).filter((d) => d.severity === 'error');
  if (errors.length > 0 || !parsed.ast) return { errors };
  const decls = (lowerModule(parsed.ast as never) as unknown as { decls?: CoreDecl[] }).decls ?? [];
  return decls.length > 0 ? { decls } : { errors: 'no declarations' };
}

function compileTypes(input: PolicyTypeSource): CompiledTypes | null {
  const lexicon = lexiconWithAliases(input.locale, input.aliasSet);
  try {
    const compiled = withVocabulary(lexicon, input.vocabulary, (target) => {
      const full = compileDecls(input.source, target);
      return 'decls' in full ? full : { ...signatureDecls(input.source, target), fullErrors: full.errors };
    });
    if (!('decls' in compiled)) {
      console.warn('[execution-input] failed to extract policy types', { locale: input.locale, errors: compiled.errors });
      return null;
    }
    if ('fullErrors' in compiled) {
      console.warn('[execution-input] policy types extracted from signatures only; full compile failed', compiled.fullErrors);
    }
    const typed = relocalizeTypes(compiled.decls, input.index ?? null);
    return {
      funcs: typed.filter((d) => d.kind === 'Func'),
      decls: typed.map(toTypeDecl).filter((d): d is PolicyDataDecl | PolicyEnumDecl => d !== null),
    };
  } catch (err) {
    console.warn('[execution-input] failed to extract policy types', err);
    return null;
  }
}

/* ---------------------------------------------------------------- 规范名 → 策略写法 */

/**
 * 规范名在策略语言里的写法：优先同类且父结构一致的词条，其次同类词条，再次任意词条；
 * 只取经引擎规范化后仍回到该规范名的写法（与映射器用 engineName 求目标名同口径）。都没有时用规范名。
 */
function policySpelling(index: VocabularyNameIndex, canonical: string, kind: IdentifierKind | null, parent: string | null): string {
  const roundTrips = (spelling: string) => engineName(index, spelling) === canonical;
  const candidates = index.terms.filter((t) => t.canonical === canonical);
  const ranked = [
    ...candidates.filter((t) => t.kind === kind && (t.parent ?? null) === parent),
    ...candidates.filter((t) => t.kind === kind),
    ...candidates,
  ];
  for (const term of ranked) {
    const spelling = term.spellings.find(roundTrips);
    if (spelling) return spelling;
  }
  return canonical;
}

function relocalizeType(index: VocabularyNameIndex, type: PolicyTypeNode): PolicyTypeNode {
  if (type.kind === 'TypeName' && 'name' in type) return { ...type, name: policySpelling(index, type.name, IdentifierKind.STRUCT, null) };
  if ('type' in type) return { ...type, type: relocalizeType(index, type.type) } as PolicyTypeNode;
  if ('baseType' in type) return { ...type, baseType: relocalizeType(index, type.baseType) } as PolicyTypeNode;
  if ('key' in type && 'val' in type) {
    return { ...type, key: relocalizeType(index, type.key), val: relocalizeType(index, type.val) } as PolicyTypeNode;
  }
  return type;
}

function relocalizeDecl(index: VocabularyNameIndex, decl: CoreDecl): CoreDecl {
  const named = (name: string, kind: IdentifierKind | null, parent: string | null = null) => policySpelling(index, name, kind, parent);
  const typed = <T extends { name: string; type: PolicyTypeNode }>(item: T, kind: IdentifierKind | null, parent: string | null) =>
    ({ ...item, name: named(item.name, kind, parent), type: relocalizeType(index, item.type) });
  return {
    ...decl,
    name: named(decl.name, decl.kind === 'Func' ? IdentifierKind.FUNCTION : IdentifierKind.STRUCT),
    ...(decl.fields ? { fields: decl.fields.map((f) => typed(f, IdentifierKind.FIELD, decl.name)) } : {}),
    ...(decl.variants ? { variants: decl.variants.map((v) => named(v, IdentifierKind.ENUM_VALUE, decl.name)) } : {}),
    ...(decl.params ? { params: decl.params.map((p) => typed(p, null, null)) } : {}),
    ...(decl.ret ? { ret: relocalizeType(index, decl.ret) } : {}),
  };
}

/** 带词汇编译得到的是规范名；还原为策略写法，交给按「策略写法」建表的映射器。 */
function relocalizeTypes(decls: readonly CoreDecl[], index: VocabularyNameIndex | null): CoreDecl[] {
  return index ? decls.map((d) => relocalizeDecl(index, d)) : [...decls];
}

/* ---------------------------------------------------------------- 入口 */

/** LRU：命中时挪到队尾，超限淘汰最久未用的。 */
function cachedCompile(input: PolicyTypeSource): CompiledTypes | null {
  const key = cacheKey(input);
  if (cache.has(key)) {
    const hit = cache.get(key)!;
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const compiled = compileTypes(input);
  cache.set(key, compiled);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return compiled;
}

/** 入口函数：指定了函数名就按规范化后的名字找（作者写法与规范名都能命中），否则取第一个函数。 */
function pickFunction(funcs: readonly CoreDecl[], functionName: string | undefined, normalize: NameNormalizer) {
  if (!functionName) return funcs[0];
  const wanted = normalize(functionName).toLowerCase();
  return funcs.find((f) => normalize(f.name).toLowerCase() === wanted);
}

/**
 * @param input 版本源码、CNL 语言、冻结别名与执行词汇
 * @param functionName 请求指定的 Rule（策略语言写法或规范名）
 * @param normalize 名字规范化（按执行词汇），用于匹配函数名
 * @returns 提取不到（源码连签名都解析不了）时返回 null
 */
export function extractPolicyInputTypes(
  input: PolicyTypeSource,
  functionName: string | undefined,
  normalize: NameNormalizer = (name) => name,
): PolicyInputTypes | null {
  const compiled = cachedCompile(input);
  if (!compiled) return null;
  const func = pickFunction(compiled.funcs, functionName, normalize);
  return {
    params: func?.params ?? [],
    ...(func?.ret ? { result: func.ret } : {}),
    decls: compiled.decls,
  };
}

/** 仅供测试：清空缓存。 */
export function clearPolicyInputTypesCache(): void {
  cache.clear();
}
