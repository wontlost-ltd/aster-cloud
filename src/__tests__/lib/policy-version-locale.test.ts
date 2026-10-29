/**
 * 已存版本 CNL 语言解析优先级：envelope 记录的编译 locale → 快照引用唯一 locale → 源码识别。
 * envelope 第 5 段为词汇作用域（ADR 0051 §7）：已审批取冻结快照，草稿取作者现行词汇。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IdentifierKind, type DomainVocabulary } from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';

const loadFrozenVocabularyForSource = vi.fn();
const loadLiveVocabularyForSource = vi.fn();
vi.mock('@/lib/domain-vocabulary-snapshot', () => ({
  loadFrozenVocabularyForSource: (...args: unknown[]) => loadFrozenVocabularyForSource(...args),
  loadLiveVocabularyForSource: (...args: unknown[]) => loadLiveVocabularyForSource(...args),
}));

import { computeSourceEnvelope, vocabularyScopesJson } from '@/lib/policy-alias';
import { recordedCompileLocale, resolveStoredVersionLocale } from '@/lib/policy-version-locale';

const DE_SOURCE = 'Modul x.\n\nDefiniere Fahrer hat alter als Ganzzahl.\n';
const ALIAS = '{"TIMES":["multiplied by"]}';
const NO_SCOPES = () => '';

const DE_VOCAB: DomainVocabulary = {
  id: 'v',
  name: 'v',
  locale: 'de-DE',
  version: '1',
  structs: [{ canonical: 'Driver', localized: 'Fahrer', kind: IdentifierKind.STRUCT }],
  fields: [],
  functions: [],
  enumValues: [],
};
const DE_SCOPES = vocabularyScopesJson(DE_VOCAB);

function stored(overrides: Partial<Parameters<typeof resolveStoredVersionLocale>[0]> = {}) {
  return {
    source: DE_SOURCE,
    aliasSet: null,
    sourceEnvelopeSha256: null,
    sourceToolchainId: 'tc-1',
    vocabularySnapshotIds: null,
    status: 'DRAFT',
    createdBy: null,
    ...overrides,
  };
}

/** 只在德语 locale 下有词汇的来源（模拟按语言筛作用域）。 */
const deOnly = (locale: string) => (locale.startsWith('de') ? DE_VOCAB : null);

beforeEach(() => {
  loadFrozenVocabularyForSource.mockReset();
  loadLiveVocabularyForSource.mockReset();
});

describe('recordedCompileLocale', () => {
  it.each(['en-US', 'de-DE', 'zh-CN', 'de'])('recovers %s from the envelope', (locale) => {
    const envelope = computeSourceEnvelope(DE_SOURCE, ALIAS, locale, 'tc-1', '');
    expect(recordedCompileLocale(stored({ aliasSet: ALIAS, sourceEnvelopeSha256: envelope }), NO_SCOPES)).toBe(locale);
  });

  it('uses the per-locale vocabulary segment', () => {
    const envelope = computeSourceEnvelope(DE_SOURCE, null, 'de-DE', 'tc-1', DE_SCOPES);
    const scopesFor = (locale: string) => vocabularyScopesJson(deOnly(locale));
    expect(recordedCompileLocale(stored({ sourceEnvelopeSha256: envelope }), scopesFor)).toBe('de-DE');
    expect(recordedCompileLocale(stored({ sourceEnvelopeSha256: envelope }), NO_SCOPES)).toBeUndefined();
  });

  it('returns undefined without an envelope or when nothing matches', () => {
    expect(recordedCompileLocale(stored(), NO_SCOPES)).toBeUndefined();
    expect(recordedCompileLocale(stored({ sourceEnvelopeSha256: 'deadbeef' }), NO_SCOPES)).toBeUndefined();
  });
});

describe('resolveStoredVersionLocale', () => {
  it('prefers the recorded compile locale over snapshots and source detection', async () => {
    const envelope = computeSourceEnvelope(DE_SOURCE, null, 'en-US', 'tc-1', '');
    const refs = [{ snapshotId: 's', domain: 'd', locale: 'de' }];
    loadFrozenVocabularyForSource.mockResolvedValue(() => null);
    await expect(
      resolveStoredVersionLocale(stored({ sourceEnvelopeSha256: envelope, vocabularySnapshotIds: refs, status: 'APPROVED' })),
    ).resolves.toBe('en-US');
  });

  it('approved versions recover the locale with their frozen snapshot vocabulary', async () => {
    const envelope = computeSourceEnvelope(DE_SOURCE, null, 'de-DE', 'tc-1', DE_SCOPES);
    const refs = [{ snapshotId: 's', domain: 'd', locale: 'de-DE' }];
    loadFrozenVocabularyForSource.mockResolvedValue(deOnly);
    await expect(
      resolveStoredVersionLocale(stored({ sourceEnvelopeSha256: envelope, vocabularySnapshotIds: refs, status: 'APPROVED' })),
    ).resolves.toBe('de-DE');
    expect(loadFrozenVocabularyForSource).toHaveBeenCalledWith(refs, DE_SOURCE);
    expect(loadLiveVocabularyForSource).not.toHaveBeenCalled();
  });

  it("drafts recover the locale with the author's live vocabulary", async () => {
    const envelope = computeSourceEnvelope(DE_SOURCE, null, 'de-DE', 'tc-1', DE_SCOPES);
    loadLiveVocabularyForSource.mockResolvedValue(deOnly);
    await expect(
      resolveStoredVersionLocale(stored({ sourceEnvelopeSha256: envelope, createdBy: 'u1' })),
    ).resolves.toBe('de-DE');
    expect(loadLiveVocabularyForSource).toHaveBeenCalledWith('u1', DE_SOURCE, undefined);
  });

  it('does not touch vocabulary without an envelope', async () => {
    await expect(resolveStoredVersionLocale(stored({ createdBy: 'u1' }))).resolves.toBe('de-DE');
    expect(loadLiveVocabularyForSource).not.toHaveBeenCalled();
  });

  it('vocabulary load failure falls back instead of failing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const envelope = computeSourceEnvelope(DE_SOURCE, null, 'en-US', 'tc-1', DE_SCOPES);
    loadLiveVocabularyForSource.mockRejectedValue(new Error('db down'));
    await expect(
      resolveStoredVersionLocale(stored({ sourceEnvelopeSha256: envelope, createdBy: 'u1' })),
    ).resolves.toBe('de-DE');
    warn.mockRestore();
  });

  it('falls back to a unique snapshot locale, then to source detection', async () => {
    await expect(resolveStoredVersionLocale(stored({ vocabularySnapshotIds: [{ locale: 'de' }, { locale: 'de' }] }))).resolves.toBe('de');
    await expect(resolveStoredVersionLocale(stored({ vocabularySnapshotIds: [{ locale: 'de' }, { locale: 'en' }] }))).resolves.toBe('de-DE');
    await expect(resolveStoredVersionLocale(stored({ source: 'Module x.\n' }))).resolves.toBe('en-US');
  });

  it('warns when an envelope exists but its locale is not recoverable (legacy 4-segment or unsupported locale)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const envelope = computeSourceEnvelope(DE_SOURCE, null, 'en-GB', 'tc-1', '');
    await expect(resolveStoredVersionLocale(stored({ sourceEnvelopeSha256: envelope }))).resolves.toBe('de-DE');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
