/**
 * 已存版本 CNL 语言解析优先级：envelope 记录的编译 locale → 快照引用唯一 locale → 源码识别。
 * envelope 第 5 段取封印时落库的 sourceScopesJson（ADR 0051 §7），不按现行/快照词汇重推。
 */
import { describe, it, expect, vi } from 'vitest';
import { IdentifierKind, type DomainVocabulary } from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';
import { computeSourceEnvelope, vocabularyScopesJson } from '@/lib/policy-alias';
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

  it('returns undefined without an envelope, without the sealed scopes (pre-ADR 0051 row) or when nothing matches', () => {
    expect(recordedCompileLocale(stored())).toBeUndefined();
    expect(recordedCompileLocale(stored({ sourceEnvelopeSha256: 'deadbeef' }))).toBeUndefined();
    const envelope = computeSourceEnvelope(DE_SOURCE, null, 'en-US', 'tc-1', '');
    expect(recordedCompileLocale(stored({ sourceEnvelopeSha256: envelope, sourceScopesJson: null }))).toBeUndefined();
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

  it('NULL sealed scopes (pre-ADR 0051 row): warns and falls back as before', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const envelope = computeSourceEnvelope(DE_SOURCE, null, 'en-US', 'tc-1', '');
    const refs = [{ locale: 'zh-CN' }];
    expect(
      resolveStoredVersionLocale(stored({ sourceEnvelopeSha256: envelope, sourceScopesJson: null, vocabularySnapshotIds: refs })),
    ).toBe('zh-CN');
    expect(resolveStoredVersionLocale(stored({ sourceEnvelopeSha256: envelope, sourceScopesJson: null }))).toBe('de-DE');
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('warns when an envelope exists but its locale is not recoverable (legacy unsupported locale)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const envelope = computeSourceEnvelope(DE_SOURCE, null, 'en-GB', 'tc-1', '');
    expect(resolveStoredVersionLocale(stored({ sourceEnvelopeSha256: envelope }))).toBe('de-DE');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
