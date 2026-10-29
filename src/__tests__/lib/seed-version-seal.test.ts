/**
 * 种子版本封印（ADR 0051）：种子直接写 PolicyVersion，落库字段必须与保存路径同构，
 * 清库重建后不再被当成需要 resolver 迁移的存量行。
 */
import { describe, it, expect } from 'vitest';
import { RESOLVER_VERSION } from '@aster-cloud/aster-lang-ts/browser';
import { sealSeedVersionChain } from '@/lib/seed-version-seal';
import { computeLegacySourceEnvelope, computeSourceEnvelope } from '@/lib/policy-alias';
import { computeChainedHash } from '@/services/security/policy-security';

const TOOLCHAIN = 'abi=1.1;core=ts;validator=1;resolver=1;casefold=15.1;build=test';
const OPTS = { locale: 'en-US', toolchainId: TOOLCHAIN };

describe('sealSeedVersionChain', () => {
  it('按保存路径规则链接：首版无 prevHash，后一版的 prevHash 是前一版的 envelope', () => {
    const [v1, v2, v3] = sealSeedVersionChain(
      [
        { content: 'Module a.', scopesJson: '' },
        { content: 'Module b.', scopesJson: '' },
        { content: 'Module c.', scopesJson: '' },
      ],
      OPTS,
    );

    expect(v1.prevHash).toBeNull();
    expect(v1.sourceHash).toBe(computeChainedHash('Module a.', null));
    expect(v2.prevHash).toBe(v1.sourceEnvelopeSha256);
    expect(v2.sourceHash).toBe(computeChainedHash('Module b.', v1.sourceEnvelopeSha256));
    expect(v3.prevHash).toBe(v2.sourceEnvelopeSha256);
    expect(v3.sourceHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('envelope 用 5 段（含封印的词汇段），不是 ADR 0051 之前的 4 段', () => {
    const [plain] = sealSeedVersionChain([{ content: 'Module a.', scopesJson: '' }], OPTS);
    const [withScopes] = sealSeedVersionChain([{ content: 'Module a.', scopesJson: '{"types":[]}' }], OPTS);

    expect(plain.sourceEnvelopeSha256).toBe(computeSourceEnvelope('Module a.', null, 'en-US', TOOLCHAIN, ''));
    expect(plain.sourceEnvelopeSha256).not.toBe(computeLegacySourceEnvelope('Module a.', null, 'en-US', TOOLCHAIN));
    expect(withScopes.sourceEnvelopeSha256).not.toBe(plain.sourceEnvelopeSha256);
    expect(withScopes.sourceScopesJson).toBe('{"types":[]}');
  });

  it('写入当前工具链身份与解析器版本，并复位 resolver 迁移列', () => {
    const [v] = sealSeedVersionChain([{ content: 'Module a.', scopesJson: '' }], OPTS);

    expect(v).toMatchObject({
      source: 'Module a.',
      content: 'Module a.',
      aliasSet: null,
      sourceToolchainId: TOOLCHAIN,
      sourceScopesJson: '',
      resolverVersion: RESOLVER_VERSION,
      resolverMigrationError: null,
      archivedByResolverMigration: false,
      statusBeforeArchive: null,
    });
  });

  it('空链返回空数组', () => {
    expect(sealSeedVersionChain([], OPTS)).toEqual([]);
  });
});
