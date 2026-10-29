/**
 * 已存版本 CNL 语言解析优先级：envelope 记录的编译 locale → 快照引用唯一 locale → 源码识别。
 * envelope 第 5 段取封印时落库的 sourceScopesJson（ADR 0051 §7），不按现行/快照词汇重推。
 */
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { IdentifierKind, type DomainVocabulary } from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';
import { computeLegacySourceEnvelope, computeSourceEnvelope, vocabularyScopesJson } from '@/lib/policy-alias';
import { recordedCompileLocale, resolveStoredVersionLocale } from '@/lib/policy-version-locale';

const DE_SOURCE = 'Modul x.\n\nDefiniere Fahrer hat alter als Ganzzahl.\n';
const ALIAS = '{"TIMES":["multiplied by"]}';

function vocab(localized: string): DomainVocabulary {
  return {
    id: 'v',
    name: 'v',
    locale: 'de-DE',
    version: '1',
    structs: [{ canonical: 'Driver', localized, kind: IdentifierKind.STRUCT }],
    fields: [],
    functions: [],
    enumValues: [],
  };
}
const V1 = vocabularyScopesJson(vocab('Fahrer'));
const V2 = vocabularyScopesJson(vocab('Lenker'));

function stored(overrides: Partial<Parameters<typeof resolveStoredVersionLocale>[0]> = {}) {
  return {
    source: DE_SOURCE,
    aliasSet: null,
    sourceEnvelopeSha256: null,
    sourceToolchainId: 'tc-1',
    sourceScopesJson: '',
    vocabularySnapshotIds: null,
    ...overrides,
  };
}

describe('recordedCompileLocale', () => {
  it.each(['en-US', 'de-DE', 'zh-CN', 'de'])('recovers %s from the envelope', (locale) => {
    const envelope = computeSourceEnvelope(DE_SOURCE, ALIAS, locale, 'tc-1', '');
    expect(recordedCompileLocale(stored({ aliasSet: ALIAS, sourceEnvelopeSha256: envelope }))).toBe(locale);
  });

  it('草稿以词汇 V1 封印、作者随后改为 V2：仍按落库的 V1 词汇段反推出记录的 locale', () => {
    expect(V1).not.toBe(V2);
    const envelope = computeSourceEnvelope(DE_SOURCE, null, 'en-US', 'tc-1', V1);
    // 若按现行词汇 V2 重推，envelope 已对不上
    expect(computeSourceEnvelope(DE_SOURCE, null, 'en-US', 'tc-1', V2)).not.toBe(envelope);
    expect(recordedCompileLocale(stored({ sourceEnvelopeSha256: envelope, sourceScopesJson: V1 }))).toBe('en-US');
  });

  it('已审批版本挂上（不同的）冻结快照后 envelope 仍匹配', () => {
    const envelope = computeSourceEnvelope(DE_SOURCE, null, 'en-US', 'tc-1', V1);
    const refs = [{ snapshotId: 's-v2', domain: 'd', locale: 'de' }];
    expect(
      recordedCompileLocale(stored({ sourceEnvelopeSha256: envelope, sourceScopesJson: V1, vocabularySnapshotIds: refs })),
    ).toBe('en-US');
  });

  it('returns undefined without an envelope or when nothing matches', () => {
    expect(recordedCompileLocale(stored())).toBeUndefined();
    expect(recordedCompileLocale(stored({ sourceEnvelopeSha256: 'deadbeef' }))).toBeUndefined();
    expect(recordedCompileLocale(stored({ sourceEnvelopeSha256: 'deadbeef', sourceScopesJson: null }))).toBeUndefined();
  });

  describe('旧行（sourceScopesJson 为 NULL）按 ADR 0051 前的 4 段 envelope 反推', () => {
    /** 与 Java PolicyVersion.computeLegacySourceEnvelope 相同的分帧（独立实现，由下方锚点钉住）。 */
    const legacy = (...fields: Array<string | null>) =>
      createHash('sha256')
        .update(fields.map((f) => `${Buffer.byteLength(f ?? '', 'utf8')}:${f ?? ''}|`).join(''), 'utf8')
        .digest('hex');
    const LEGACY_TC = 'abi=1.0;core=ts;validator=1;build=abc123';

    it('分帧与既有 4 段锚点一致（printf "1:a|0:|0:|0:|" | openssl dgst -sha256）', () => {
      expect(legacy('a', null, '', '')).toBe('68fbcc50d3fabae237194d8c0f3e0795308e3f317e6244252ac5609be49620a9');
      expect(computeLegacySourceEnvelope('a', null, '', '')).toBe(legacy('a', null, '', ''));
    });

    it('生产实现与独立分帧逐字节一致（多字节 UTF-8 与 null 段）', () => {
      expect(computeLegacySourceEnvelope(DE_SOURCE, ALIAS, 'de-DE', LEGACY_TC)).toBe(legacy(DE_SOURCE, ALIAS, 'de-DE', LEGACY_TC));
      expect(computeLegacySourceEnvelope('规则 ä', null, null, 'tc')).toBe(legacy('规则 ä', null, null, 'tc'));
    });

    it.each(['en-US', 'de-DE', 'zh-CN', 'de'])('recovers %s with the stored legacy toolchain id', (locale) => {
      const envelope = legacy(DE_SOURCE, ALIAS, locale, LEGACY_TC);
      expect(
        recordedCompileLocale(
          stored({ aliasSet: ALIAS, sourceEnvelopeSha256: envelope, sourceToolchainId: LEGACY_TC, sourceScopesJson: null }),
        ),
      ).toBe(locale);
    });

    it('有封印词汇段的新行不接受 4 段 envelope', () => {
      const envelope = legacy(DE_SOURCE, null, 'en-US', LEGACY_TC);
      expect(
        recordedCompileLocale(stored({ sourceEnvelopeSha256: envelope, sourceToolchainId: LEGACY_TC, sourceScopesJson: '' })),
      ).toBeUndefined();
    });
  });
});

describe('resolveStoredVersionLocale', () => {
  it('prefers the recorded compile locale over snapshots and source detection', () => {
    const envelope = computeSourceEnvelope(DE_SOURCE, null, 'en-US', 'tc-1', '');
    const refs = [{ snapshotId: 's', domain: 'd', locale: 'de' }];
    expect(resolveStoredVersionLocale(stored({ sourceEnvelopeSha256: envelope, vocabularySnapshotIds: refs }))).toBe('en-US');
  });

  it('falls back to a unique snapshot locale, then to source detection', () => {
    expect(resolveStoredVersionLocale(stored({ vocabularySnapshotIds: [{ locale: 'de' }, { locale: 'de' }] }))).toBe('de');
    expect(resolveStoredVersionLocale(stored({ vocabularySnapshotIds: [{ locale: 'de' }, { locale: 'en' }] }))).toBe('de-DE');
    expect(resolveStoredVersionLocale(stored({ source: 'Module x.\n' }))).toBe('en-US');
  });

  it('NULL sealed scopes and no legacy match: falls back to snapshot locale, then source detection (debug only)', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const envelope = computeSourceEnvelope(DE_SOURCE, null, 'en-US', 'tc-1', '');
    const refs = [{ locale: 'zh-CN' }];
    expect(
      resolveStoredVersionLocale(stored({ sourceEnvelopeSha256: envelope, sourceScopesJson: null, vocabularySnapshotIds: refs })),
    ).toBe('zh-CN');
    expect(resolveStoredVersionLocale(stored({ sourceEnvelopeSha256: envelope, sourceScopesJson: null }))).toBe('de-DE');
    expect(debug).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
    debug.mockRestore();
    warn.mockRestore();
  });

  it('logs at debug when an envelope exists but its locale is not recoverable (legacy unsupported locale)', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const envelope = computeSourceEnvelope(DE_SOURCE, null, 'en-GB', 'tc-1', '');
    expect(resolveStoredVersionLocale(stored({ sourceEnvelopeSha256: envelope }))).toBe('de-DE');
    expect(debug).toHaveBeenCalledTimes(1);
    debug.mockRestore();
  });
});
