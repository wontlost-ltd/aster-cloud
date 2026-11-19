// ADR 0060 §7.2–7.3 / 计划 T10：execution-input 是所有读版本编译输入的唯一层，在这里把版本行上的
// 内嵌词汇并入下层（冻结快照 / 作者现行）词汇；已审批 / 已弃用版本按封印复核，不符 fail-closed。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const snapshot = vi.hoisted(() => ({
  loadVocabularyForExecution: vi.fn(),
  loadLiveVocabularyForPolicy: vi.fn(),
  loadExecutionVocabulary: vi.fn(),
}));
vi.mock('@/lib/domain-vocabulary-snapshot', () => snapshot);

import type { DomainVocabulary } from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';
import {
  loadStoredVersionCompileContext,
  loadVersionExecutionVocabulary,
  VersionVocabularyUnavailableError,
  VocabularySealMismatchError,
  type ExecutionVocabularyTarget,
} from '@/lib/execution-input';
import { vocabularyScopesJson } from '@/lib/policy-alias';
import { withEmbeddedVocabulary } from '@/lib/policy-embedded-vocabulary';

const POEM = '{"v":1,"terms":[{"kind":"literal","localized":"思故乡","canonical":"静夜思"},{"kind":"struct","localized":"望明月","canonical":"Text"}]}';
const SOURCE = '床前 明月光。\n疑是 地上霜，举头 望明月：\n  低头 思故乡。';

const vocab = (structs: Array<[string, string]>): DomainVocabulary => ({
  id: 'user', name: 'user', locale: 'zh-CN', version: '1',
  structs: structs.map(([localized, canonical]) => ({ kind: 'struct', localized, canonical }) as DomainVocabulary['structs'][number]),
  fields: [], functions: [], enumValues: [],
});
/** 作者在审批之后新增的同形个人词条。 */
const MOON = vocab([['望明月', 'Moon']]);
const SEAL = vocabularyScopesJson(withEmbeddedVocabulary(null, POEM, 'zh-CN'));

const target = (over: Partial<ExecutionVocabularyTarget> = {}): ExecutionVocabularyTarget => ({
  status: 'APPROVED',
  vocabularySnapshotIds: [{ snapshotId: 's1', domain: 'd', locale: 'zh' }],
  authorId: 'a1',
  source: SOURCE,
  locale: 'zh-CN',
  embeddedVocabulary: POEM,
  sourceScopesJson: SEAL,
  ...over,
});

const literalsOf = (v: Record<string, unknown> | undefined) => (v as unknown as DomainVocabulary | undefined)?.literals ?? [];
const structsOf = (v: Record<string, unknown> | undefined) => (v as unknown as DomainVocabulary | undefined)?.structs ?? [];

describe('loadVersionExecutionVocabulary — 内嵌词汇', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    snapshot.loadVocabularyForExecution.mockResolvedValue(null);
    snapshot.loadLiveVocabularyForPolicy.mockResolvedValue(null);
  });

  it('execution vocabulary of a draft includes embedded terms', async () => {
    snapshot.loadLiveVocabularyForPolicy.mockResolvedValue(vocab([['明月', 'Moonlight']]));
    const v = await loadVersionExecutionVocabulary(target({ status: 'DRAFT' }));
    expect(literalsOf(v)).toEqual([expect.objectContaining({ localized: '思故乡', canonical: '静夜思' })]);
    expect(structsOf(v).map((s) => s.canonical).sort()).toEqual(['Moonlight', 'Text']);
    expect(snapshot.loadLiveVocabularyForPolicy).toHaveBeenCalledTimes(1);
  });

  it('approved version executes with embedded vocabulary after the author adds a colliding term', async () => {
    // 快照里即便冻进了同形作者词条，合并时也被内嵌词条遮蔽；词汇段仍等于封印
    snapshot.loadVocabularyForExecution.mockResolvedValue(MOON);
    const v = await loadVersionExecutionVocabulary(target());
    expect(structsOf(v)).toEqual([expect.objectContaining({ localized: '望明月', canonical: 'Text' })]);
    expect(vocabularyScopesJson(v as unknown as DomainVocabulary)).toBe(SEAL);
  });

  it.each(['APPROVED', 'DEPRECATED'])('rejects execution of a %s version when the embedded column no longer matches the seal', async (status) => {
    const tampered = POEM.replace('静夜思', '静夜诗');
    for (const strict of [false, true]) {
      await expect(loadVersionExecutionVocabulary(target({ status, embeddedVocabulary: tampered }), { strict }))
        .rejects.toBeInstanceOf(VocabularySealMismatchError);
    }
    const caught = await loadVersionExecutionVocabulary(target({ status, embeddedVocabulary: tampered })).catch((e: unknown) => e);
    expect((caught as VocabularySealMismatchError).code).toBe('vocabulary_seal_mismatch');
  });

  it('a stored text that cannot be parsed is a seal mismatch for every status, never a silent fallback', async () => {
    for (const status of ['APPROVED', 'DRAFT', null]) {
      await expect(loadVersionExecutionVocabulary(target({ status, embeddedVocabulary: '{"v":1' })))
        .rejects.toBeInstanceOf(VocabularySealMismatchError);
    }
  });

  it('drafts and pre-seal rows are not compared with the seal', async () => {
    await expect(loadVersionExecutionVocabulary(target({ status: 'DRAFT', sourceScopesJson: 'stale' }))).resolves.toBeDefined();
    await expect(loadVersionExecutionVocabulary(target({ sourceScopesJson: null }))).resolves.toBeDefined();
  });

  it('a version with embedded vocabulary loads its lower vocabulary strictly (no silent degrade)', async () => {
    snapshot.loadVocabularyForExecution.mockRejectedValueOnce(new Error('db down'));
    await expect(loadVersionExecutionVocabulary(target())).rejects.toBeInstanceOf(VersionVocabularyUnavailableError);
    expect(snapshot.loadExecutionVocabulary).not.toHaveBeenCalled();
  });

  it('a draft without author still gets its embedded terms', async () => {
    const v = await loadVersionExecutionVocabulary(target({ status: 'DRAFT', authorId: null }));
    expect(literalsOf(v)).toHaveLength(1);
    expect(snapshot.loadLiveVocabularyForPolicy).not.toHaveBeenCalled();
  });
});

describe('versions without embedded vocabulary behave exactly as before', () => {
  const lower = { id: 'v', locale: 'de-DE', structs: [], fields: [], functions: [] };

  beforeEach(() => {
    vi.clearAllMocks();
    snapshot.loadExecutionVocabulary.mockResolvedValue(lower);
    snapshot.loadVocabularyForExecution.mockResolvedValue(lower);
    snapshot.loadLiveVocabularyForPolicy.mockResolvedValue(lower);
  });

  it.each([null, undefined, ''])('embeddedVocabulary=%j: best-effort path, same object, no seal comparison', async (embedded) => {
    const v = await loadVersionExecutionVocabulary(target({ embeddedVocabulary: embedded, sourceScopesJson: 'anything' }));
    expect(v).toBe(lower);
    expect(snapshot.loadExecutionVocabulary).toHaveBeenCalledTimes(1);
    expect(snapshot.loadVocabularyForExecution).not.toHaveBeenCalled();
  });

  it('frozen load failure still degrades to no vocabulary on the execution path', async () => {
    snapshot.loadExecutionVocabulary.mockResolvedValueOnce(undefined);
    await expect(loadVersionExecutionVocabulary(target({ embeddedVocabulary: null }))).resolves.toBeUndefined();
  });
});

describe('loadStoredVersionCompileContext — 内嵌词汇', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    snapshot.loadVocabularyForExecution.mockResolvedValue(MOON);
  });

  const stored = (over: Record<string, unknown> = {}) => ({
    source: SOURCE, status: 'APPROVED', createdBy: 'a1', aliasSet: null,
    vocabularySnapshotIds: [{ snapshotId: 's1', domain: 'd', locale: 'zh' }],
    sourceEnvelopeSha256: null, sourceScopesJson: SEAL, sourceToolchainId: null, embeddedVocabulary: POEM,
    ...over,
  });

  it('merges embedded terms into the compile vocabulary (Cedar / package export / Guard deploy / What-If source)', async () => {
    const ctx = await loadStoredVersionCompileContext(stored());
    expect(literalsOf(ctx.vocabulary)).toEqual([expect.objectContaining({ localized: '思故乡' })]);
    expect(structsOf(ctx.vocabulary)).toEqual([expect.objectContaining({ canonical: 'Text' })]);
  });

  it('a seal mismatch is thrown, not degraded', async () => {
    await expect(loadStoredVersionCompileContext(stored({ sourceScopesJson: '' }))).rejects.toBeInstanceOf(VocabularySealMismatchError);
  });
});
