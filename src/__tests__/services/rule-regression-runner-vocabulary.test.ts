/**
 * 回归基线 / 回放带版本领域词汇（ADR 0051）：与执行同一口径（已审批取冻结快照、草稿取作者现行词汇），
 * 同一 run 内按 locale 只加载一次。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const evaluateSource = vi.hoisted(() => vi.fn());
const loadVersionExecutionVocabulary = vi.hoisted(() => vi.fn());
vi.mock('@/services/policy/policy-api', () => ({
  createPolicyApiClient: () => ({ evaluateSource }),
}));
vi.mock('@/lib/execution-input', () => ({ loadVersionExecutionVocabulary }));
vi.mock('@/lib/prisma', () => ({ db: {} }));

import { caseVocabulary, evaluateForCapture, versionVocabularyLoader } from '@/services/policy/rule-regression-runner';

const vocabulary = { id: 'grades', locale: 'de-DE', structs: [], fields: [], functions: [] };
const pv = { content: 'Modul m.', status: 'APPROVED', createdBy: 'a1', vocabularySnapshotIds: [{ snapshotId: 's1' }] };

describe('rule-regression-runner 词汇', () => {
  beforeEach(() => {
    evaluateSource.mockReset().mockResolvedValue({ replayMetadata: {} });
    loadVersionExecutionVocabulary.mockReset().mockResolvedValue(vocabulary);
  });

  it('versionVocabularyLoader 按版本状态 / 快照 / 作者加载，并按 locale 缓存', async () => {
    const load = versionVocabularyLoader(pv);
    expect(await load('de-DE')).toEqual(vocabulary);
    await load('de-DE');
    await load('en-US');
    expect(loadVersionExecutionVocabulary).toHaveBeenCalledTimes(2);
    // 严格加载（#650）：回归基线必须与执行同一份词汇，失败不退化为无词汇
    expect(loadVersionExecutionVocabulary).toHaveBeenCalledWith({
      status: 'APPROVED', vocabularySnapshotIds: pv.vocabularySnapshotIds, authorId: 'a1', source: 'Modul m.', locale: 'de-DE',
    }, { strict: true });
  });

  it('caseVocabulary：加载成功返回词汇；失败按原因给出不可回放理由（不算通过也不算回归）', async () => {
    expect(await caseVocabulary(async () => vocabulary, 'de-DE')).toEqual({ ok: true, vocabulary });
    expect(await caseVocabulary(null, 'de-DE')).toEqual({ ok: true, vocabulary: undefined });

    const unavailable = Object.assign(new Error('db down'), { name: 'VersionVocabularyUnavailableError' });
    expect(await caseVocabulary(async () => { throw unavailable; }, 'de-DE'))
      .toEqual({ ok: false, reason: 'VOCABULARY_UNAVAILABLE' });

    const invalid = Object.assign(new Error('field_parent_required: x'), { name: 'VocabularyScopeError' });
    expect(await caseVocabulary(async () => { throw invalid; }, 'de-DE'))
      .toEqual({ ok: false, reason: 'VOCABULARY_SCOPE_INVALID' });
  });

  it('evaluateForCapture 把词汇交给 aster-api，无词汇时省略', async () => {
    const params = {
      tenantId: 't', actorUserId: 'u', source: 'Modul m.', input: {}, locale: 'de-DE', functionName: 'f', aliasSet: null,
    };
    await evaluateForCapture({ ...params, vocabulary });
    expect(evaluateSource.mock.calls[0][2]).toMatchObject({ vocabulary, replayCapture: true });

    await evaluateForCapture({ ...params, vocabulary: undefined });
    expect(evaluateSource.mock.calls[1][2]).not.toHaveProperty('vocabulary');
  });
});
