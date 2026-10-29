// #650：What-If 重放、Cedar 导出、回归基线按已存版本重编译时，词汇加载失败不能静默退化为无词汇
// （会得到误导性的编译错误，或被静默算错的回归基线 / Cedar 产物）。执行路径保持 best-effort。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const snapshot = vi.hoisted(() => ({
  loadVocabularyForExecution: vi.fn(),
  loadLiveVocabularyForPolicy: vi.fn(),
  loadExecutionVocabulary: vi.fn(),
}));
vi.mock('@/lib/domain-vocabulary-snapshot', () => snapshot);

import { VocabularyScopeError } from '@aster-cloud/aster-lang-ts/browser';
import {
  loadStoredVersionCompileContext,
  loadVersionExecutionVocabulary,
  VersionVocabularyUnavailableError,
} from '@/lib/execution-input';

const vocabulary = { id: 'v', locale: 'de-DE', structs: [], fields: [], functions: [] };
const stored = (status: string, createdBy: string | null = 'a1') => ({
  source: 'Modul m.\n', status, createdBy, aliasSet: null, vocabularySnapshotIds: [{ snapshotId: 's1', domain: 'd', locale: 'de' }],
  sourceEnvelopeSha256: null, sourceScopesJson: null, sourceToolchainId: null,
});

describe('loadStoredVersionCompileContext — 严格加载词汇', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    snapshot.loadVocabularyForExecution.mockResolvedValue(vocabulary);
    snapshot.loadLiveVocabularyForPolicy.mockResolvedValue(vocabulary);
  });

  it('已审批：取冻结快照', async () => {
    const ctx = await loadStoredVersionCompileContext(stored('APPROVED'));
    expect(ctx.vocabulary).toEqual(vocabulary);
    expect(snapshot.loadVocabularyForExecution).toHaveBeenCalledTimes(1);
  });

  it('草稿：取作者现行词汇；无作用域内词汇 → undefined', async () => {
    snapshot.loadLiveVocabularyForPolicy.mockResolvedValueOnce(null);
    const ctx = await loadStoredVersionCompileContext(stored('DRAFT'));
    expect(ctx.vocabulary).toBeUndefined();
    expect(snapshot.loadLiveVocabularyForPolicy).toHaveBeenCalledWith('a1', expect.objectContaining({ source: 'Modul m.\n' }));
  });

  it('草稿无作者：不带词汇（与审批冻结同口径），不报错', async () => {
    await expect(loadStoredVersionCompileContext(stored('DRAFT', null))).resolves.toMatchObject({ vocabulary: undefined });
    expect(snapshot.loadLiveVocabularyForPolicy).not.toHaveBeenCalled();
  });

  it.each(['APPROVED', 'DRAFT'])('%s 词汇加载失败 → VersionVocabularyUnavailableError（vocabulary_unavailable）', async (status) => {
    const loader = status === 'APPROVED' ? snapshot.loadVocabularyForExecution : snapshot.loadLiveVocabularyForPolicy;
    loader.mockRejectedValueOnce(new Error('db down'));
    const caught = await loadStoredVersionCompileContext(stored(status)).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(VersionVocabularyUnavailableError);
    expect((caught as VersionVocabularyUnavailableError).code).toBe('vocabulary_unavailable');
  });

  it('作者词汇非法 → VocabularyScopeError 原样上抛（不是暂不可用）', async () => {
    const scopeError = new VocabularyScopeError('field_parent_required', '字段 "alter" 缺少 parent');
    snapshot.loadLiveVocabularyForPolicy.mockRejectedValueOnce(scopeError);
    await expect(loadStoredVersionCompileContext(stored('DRAFT'))).rejects.toBe(scopeError);
  });
});

describe('loadVersionExecutionVocabulary — 执行路径仍 best-effort', () => {
  beforeEach(() => vi.clearAllMocks());

  it('草稿现行词汇加载失败 → undefined（不阻断执行）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    snapshot.loadLiveVocabularyForPolicy.mockRejectedValueOnce(new Error('db down'));
    await expect(loadVersionExecutionVocabulary({
      status: 'DRAFT', vocabularySnapshotIds: null, authorId: 'a1', source: 's', locale: 'de-DE',
    })).resolves.toBeUndefined();
  });

  it('strict 选项：失败抛错', async () => {
    snapshot.loadLiveVocabularyForPolicy.mockRejectedValueOnce(new Error('db down'));
    await expect(loadVersionExecutionVocabulary({
      status: 'DRAFT', vocabularySnapshotIds: null, authorId: 'a1', source: 's', locale: 'de-DE',
    }, { strict: true })).rejects.toBeInstanceOf(VersionVocabularyUnavailableError);
  });
});
