/**
 * 已存版本 CNL 语言解析优先级：envelope 记录的编译 locale → 快照引用唯一 locale → 源码识别。
 */
import { describe, it, expect, vi } from 'vitest';
import { computeSourceEnvelope } from '@/lib/policy-alias';
import { recordedCompileLocale, resolveStoredVersionLocale } from '@/lib/policy-version-locale';

const DE_SOURCE = 'Modul x.\n\nDefiniere Fahrer hat alter als Ganzzahl.\n';
const ALIAS = '{"TIMES":["multiplied by"]}';

function stored(overrides: Partial<Parameters<typeof resolveStoredVersionLocale>[0]> = {}) {
  return {
    source: DE_SOURCE,
    aliasSet: null,
    sourceEnvelopeSha256: null,
    sourceToolchainId: 'tc-1',
    vocabularySnapshotIds: null,
    ...overrides,
  };
}

describe('recordedCompileLocale', () => {
  it.each(['en-US', 'de-DE', 'zh-CN', 'de'])('recovers %s from the envelope', (locale) => {
    const envelope = computeSourceEnvelope(DE_SOURCE, ALIAS, locale, 'tc-1');
    expect(recordedCompileLocale(stored({ aliasSet: ALIAS, sourceEnvelopeSha256: envelope }))).toBe(locale);
  });

  it('returns undefined without an envelope or when nothing matches', () => {
    expect(recordedCompileLocale(stored())).toBeUndefined();
    expect(recordedCompileLocale(stored({ sourceEnvelopeSha256: 'deadbeef' }))).toBeUndefined();
  });
});

describe('resolveStoredVersionLocale', () => {
  it('prefers the recorded compile locale over snapshots and source detection', () => {
    const envelope = computeSourceEnvelope(DE_SOURCE, null, 'en-US', 'tc-1');
    const refs = [{ snapshotId: 's', domain: 'd', locale: 'de' }];
    expect(resolveStoredVersionLocale(stored({ sourceEnvelopeSha256: envelope, vocabularySnapshotIds: refs }))).toBe('en-US');
  });

  it('falls back to a unique snapshot locale, then to source detection', () => {
    expect(resolveStoredVersionLocale(stored({ vocabularySnapshotIds: [{ locale: 'de' }, { locale: 'de' }] }))).toBe('de');
    expect(resolveStoredVersionLocale(stored({ vocabularySnapshotIds: [{ locale: 'de' }, { locale: 'en' }] }))).toBe('de-DE');
    expect(resolveStoredVersionLocale(stored({ source: 'Module x.\n' }))).toBe('en-US');
  });

  it('warns when an envelope exists but its locale is not recoverable (legacy unsupported locale)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const envelope = computeSourceEnvelope(DE_SOURCE, null, 'en-GB', 'tc-1');
    expect(resolveStoredVersionLocale(stored({ sourceEnvelopeSha256: envelope }))).toBe('de-DE');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
