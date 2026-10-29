/**
 * 种子脚本直接写 PolicyVersion 时的封印字段（ADR 0051）。
 *
 * 种子绕过 REST 保存门（createVersion），但落库的行必须与保存路径产出的行同构，否则会被当成
 * ADR 0051 之前的存量行：resolver 迁移要重新处理（resolverVersion 为空），审批走 NULL
 * sourceScopesJson 的旧行分支，完整性检查按旧 4 段 envelope / 非链式哈希判定不一致。
 * 这里只组合保存路径用的同一组原语（链式哈希、5 段 envelope、工具链身份、解析器版本），不另立规则。
 */
import { RESOLVER_VERSION } from '@aster-cloud/aster-lang-ts/browser';
import { computeSourceEnvelope } from '@/lib/policy-alias';
import { computeChainedHash } from '@/services/security/policy-security';

export interface SeedVersionInput {
  /** 版本源码。 */
  readonly content: string;
  /** 保存时封印的词汇段（loadSaveVocabulary 的 scopesJson；无词汇为空串）。 */
  readonly scopesJson: string;
}

export interface SealedSeedVersionFields {
  readonly source: string;
  readonly content: string;
  readonly sourceHash: string;
  readonly prevHash: string | null;
  readonly aliasSet: null;
  readonly sourceEnvelopeSha256: string;
  readonly sourceToolchainId: string;
  readonly sourceScopesJson: string;
  readonly resolverVersion: number;
  readonly resolverMigrationError: null;
  readonly archivedByResolverMigration: false;
  readonly statusBeforeArchive: null;
}

/**
 * 按版本号升序给出一条策略整条链的封印字段。链接规则同 insertChainedVersion：
 * 后一版的 prevHash 取前一版的 sourceEnvelopeSha256（前一版没有 envelope 时退回 sourceHash）。
 * 种子不带别名，aliasSet 恒为 null；resolver 迁移相关列显式复位，重跑种子时覆盖旧值。
 */
export function sealSeedVersionChain(
  versions: readonly SeedVersionInput[],
  opts: { readonly locale: string; readonly toolchainId: string },
): SealedSeedVersionFields[] {
  let prevHash: string | null = null;
  return versions.map(({ content, scopesJson }) => {
    const sourceEnvelopeSha256 = computeSourceEnvelope(content, null, opts.locale, opts.toolchainId, scopesJson);
    const sealed: SealedSeedVersionFields = {
      source: content,
      content,
      sourceHash: computeChainedHash(content, prevHash),
      prevHash,
      aliasSet: null,
      sourceEnvelopeSha256,
      sourceToolchainId: opts.toolchainId,
      sourceScopesJson: scopesJson,
      resolverVersion: RESOLVER_VERSION,
      resolverMigrationError: null,
      archivedByResolverMigration: false,
      statusBeforeArchive: null,
    };
    prevHash = sourceEnvelopeSha256;
    return sealed;
  });
}
