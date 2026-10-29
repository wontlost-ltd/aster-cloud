/**
 * 用户自定义关键词别名 —— **服务端** 信封哈希 + 工具链身份（ADR 0022 方案 D）。
 *
 * <p>校验/规范化核心（validateUserAliases / canonicalAliasJson / normalize / 合并）已抽到
 * client-safe 的 {@link ./policy-alias-shared}（不含 node:crypto，可浏览器 import 做前端预校验）。
 * 本模块只保留依赖 Node 内建/环境的部分：
 * <ul>
 *   <li>{@link computeSourceEnvelope} —— 长度前缀分帧 SHA-256（node:crypto），与 Java
 *       PolicyVersion.computeSourceEnvelope 逐字节对齐（防别名替换篡改 C1）</li>
 *   <li>{@link computeLegacySourceEnvelope} —— ADR 0051 前的 4 段 envelope，与 5 段共用同一分帧，仅识别旧行</li>
 *   <li>{@link cloudToolchainId} —— 读 process.env 构建 sha，进 source envelope</li>
 *   <li>{@link vocabularyScopesJson} —— envelope 第 5 段（词汇作用域规范 JSON，ADR 0051 §7）</li>
 * </ul>
 * 并 re-export shared 符号以保持既有导入路径向后兼容。
 *
 * <p><b>跨引擎一致性铁律</b>：envelope/canonical 算法与 Java 侧必须逐字节一致。parity 由
 * 共享向量 envelope-vectors.json（source-envelope.test.ts）钉住。任一侧改算法，两侧同步改 + 更新向量。
 */
import { createHash } from 'node:crypto';
import {
  CASEFOLD_VERSION,
  CORE_IR_ABI,
  RESOLVER_VERSION,
  buildVocabularyScopes,
  canonicalScopesJson,
} from '@aster-cloud/aster-lang-ts/browser';
import type { DomainVocabulary } from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';
import { USER_ALIAS_VALIDATOR_VERSION } from './policy-alias-shared';

// re-export client-safe 核心（向后兼容既有 `import { validateUserAliases, ... } from './policy-alias'`）。
export {
  ALLOWED_KINDS,
  OPERATOR_KINDS,
  STRUCTURAL_KINDS,
  USER_ALIAS_VALIDATOR_VERSION,
  normalizeAliasToken,
  validateUserAliases,
  canonicalAliasJson,
  mergeAliasSets,
} from './policy-alias-shared';
export type {
  AliasSet,
  AliasValidationResult,
  AliasValidationOptions,
  ReservedSets,
} from './policy-alias-shared';

/**
 * 工具链身份串（单一来源，进 source envelope）。所有版本创建路径必须用同一拼法，否则同内容
 * 算出不同 envelope。格式与 Java toolchainIdentity 对齐（ADR 0051 §9）：
 * abi/core/validator/resolver/casefold/build；abi、resolver、casefold 取自引擎常量，
 * build 由 env 注入（部署 sha）。
 */
export function cloudToolchainId(): string {
  const build = process.env.ASTER_RUNTIME_BUILD ?? 'dev';
  return (
    `abi=${CORE_IR_ABI};core=ts;validator=${USER_ALIAS_VALIDATOR_VERSION};` +
    `resolver=${RESOLVER_VERSION};casefold=${CASEFOLD_VERSION};build=${build}`
  );
}

/**
 * envelope 第 5 段（ADR 0051 §7，与 Java CompileIdentity.scopesJson 同规则）：无词汇或词汇没有
 * 任何条目时为空串（不序列化空 scopes）；否则为引擎 canonicalScopesJson。只含字面量宏的词汇
 * 也算有词汇——宏会改变编译输入。词汇非法（如字段缺 parent）时引擎抛错，原样上抛。
 */
export function vocabularyScopesJson(vocabulary: DomainVocabulary | null | undefined): string {
  if (!vocabulary) return '';
  const scopes = buildVocabularyScopes(vocabulary);
  const empty =
    scopes.types.size === 0 &&
    scopes.fields.size === 0 &&
    scopes.enumMembers.size === 0 &&
    scopes.functions.size === 0 &&
    scopes.literals.size === 0;
  return empty ? '' : canonicalScopesJson(scopes);
}

/**
 * envelope 的分帧与摘要（5 段与旧 4 段共用，与 Java PolicyVersion 的 envelope 分帧逐字节对齐）。
 *
 * 长度前缀分帧：每段 `<byteLen>:<utf8bytes>|`（byteLen 用 UTF-8 字节数，非字符数），null → 空串；
 * 返回整串的 SHA-256 十六进制。
 */
function lengthPrefixedSha256(fields: ReadonlyArray<string | null>): string {
  const hash = createHash('sha256');
  for (const field of fields) {
    const bytes = Buffer.from(field ?? '', 'utf8');
    hash.update(`${bytes.length}:`, 'ascii');
    hash.update(bytes);
    hash.update('|', 'ascii');
  }
  return hash.digest('hex');
}

/**
 * 计算完整编译输入的 SHA-256 信封哈希（与 Java PolicyVersion.computeSourceEnvelope 逐字节对齐）。
 * 字段顺序：content, aliasSetJson, locale, toolchainId, scopesJson（{@link vocabularyScopesJson}），
 * 分帧见 {@link lengthPrefixedSha256}。
 */
export function computeSourceEnvelope(
  content: string | null,
  aliasSetJson: string | null,
  locale: string | null,
  toolchainId: string | null,
  scopesJson: string | null,
): string {
  return lengthPrefixedSha256([content, aliasSetJson, locale, toolchainId, scopesJson]);
}

/**
 * ADR 0051 之前的 4 段 envelope（content, aliasSetJson, locale, toolchainId），与 Java
 * PolicyVersion.computeLegacySourceEnvelope 逐字节一致。只用于识别 sourceScopesJson 为 NULL 的
 * 旧行，新行一律用 5 段 {@link computeSourceEnvelope}。
 */
export function computeLegacySourceEnvelope(
  content: string | null,
  aliasSetJson: string | null,
  locale: string | null,
  toolchainId: string | null,
): string {
  return lengthPrefixedSha256([content, aliasSetJson, locale, toolchainId]);
}
