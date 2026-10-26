// 异步批量任务完成卡：未导入按原因分组（#636），行级校验失败不显示引擎中文原文（#634）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, screen, waitFor } from '@testing-library/react';

vi.mock('lucide-react', async (orig) => ({ ...((await orig()) as Record<string, unknown>) }));

const t = vi.hoisted(() => (key: string, params?: Record<string, unknown>) =>
  params ? `${key}:${JSON.stringify(params)}` : key);
vi.mock('next-intl', () => ({
  useTranslations: () => t,
}));

import { BulkJobProgress } from '@/app/[locale]/(dashboard)/domain-vocabularies/bulk-job-progress';
import { useVocabularyErrors } from '@/app/[locale]/(dashboard)/domain-vocabularies/use-vocabulary-errors';

const ENGINE_INVALID = 'structs[0]: 规范化名称 "Bad Name!" 必须是有效的 ASCII 标识符';
const CJK = /[㐀-鿿]/;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    job: {
      id: 'j1', status: 'completed', rowCount: 4, processed: 4,
      rollup: { added: 1, reused: 0, modified: 0, skipped: 3, errorCount: 3 },
      errors: [
        { row: 1, code: 'duplicate_link', message: 'You already have this term in your vocabulary' },
        { row: 2, code: 'duplicate_link', message: 'You already have this term in your vocabulary' },
        { row: 3, code: 'validation_failed', message: ENGINE_INVALID },
      ],
      updatedAt: '2026-10-27T00:00:00Z', completedAt: '2026-10-27T00:00:00Z',
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })));
});

afterEach(() => vi.unstubAllGlobals());

describe('BulkJobProgress — 完成卡', () => {
  it('★未导入按原因分组，行级原因本地化且不含中文', async () => {
    render(<BulkJobProgress jobId="j1" onClear={vi.fn()} />);
    const reasons = await screen.findByRole('list', { name: 'skippedReasons.title' }, { timeout: 3000 });
    expect([...reasons.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'skippedReasons.existing:{"n":2}',
      'skippedReasons.invalid:{"n":1}',
    ]);
    await waitFor(() => expect(screen.getByText(/rowErrors\.validation_failed/)).toBeInTheDocument());
    expect(screen.getByText(/rowErrors\.validation_failed/).textContent)
      .toBe('rowLabel:{"row":4}: rowErrors.validation_failed: errors.validation.invalidCanonical:{"name":"Bad Name!"}');
    expect(document.body.textContent).not.toMatch(CJK);
  });
});

describe('useVocabularyErrors — 错误信封本地化（单条新增/编辑、整批、快照回滚共用）', () => {
  it('validation_failed 按原因码本地化，识别不了用通用提示；已知码用码文案；未知码用调用方兜底', () => {
    const { result } = renderHook(() => useVocabularyErrors());
    const errors = result.current;
    expect(errors.envelope('validation_failed', ENGINE_INVALID, 'fallback'))
      .toBe('errors.validation.invalidCanonical:{"name":"Bad Name!"}');
    expect(errors.envelope('validation_failed', '未知中文诊断', 'fallback')).toBe('errors.validation.generic');
    expect(errors.envelope('quota_exceeded', '配额已满', 'fallback')).toBe('errors.quota_exceeded');
    expect(errors.envelope('snapshot_archived', 'Snapshot has been archived', 'fallback')).toBe('fallback');
    expect(errors.envelope(undefined, undefined, 'fallback')).toBe('fallback');
    expect(errors.validationReason('something unexpected')).toBeNull();
  });
});
