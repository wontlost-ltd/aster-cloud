// 同步批量导入的结果呈现（#607/#636）、错误本地化（#634）与客户端 domain/locale 格式校验（#612）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('lucide-react', async (orig) => ({ ...((await orig()) as Record<string, unknown>) }));

// t 必须是稳定引用：真实 next-intl 的 t 不随渲染变化，组件把它放进 effect 依赖。
const t = vi.hoisted(() => (key: string, params?: Record<string, unknown>) =>
  params ? `${key}:${JSON.stringify(params)}` : key);
vi.mock('next-intl', () => ({
  useTranslations: () => t,
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock('@/components/ui', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  toast,
}));

import { BulkUploadDialog } from '@/app/[locale]/(dashboard)/domain-vocabularies/bulk-upload-dialog';
import {
  normalizeRowErrors,
  skippedBreakdown,
  summarizeBulkOutcome,
} from '@/app/[locale]/(dashboard)/domain-vocabularies/bulk-result';

const CSV = [
  'domain,locale,kind,canonical,localized',
  'insurance.auto,de,struct,Policyholder,Versicherungsnehmer',
  'insurance.auto,de,struct,Driver,Fahrer',
  'insurance.auto,de,field,premium,Prämie',
  'insurance.auto,de,struct,9bad,Kaputt',
].join('\n');

function respond(body: unknown, status = 200) {
  vi.mocked(global.fetch).mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
}

const CJK = /[\u3400-\u9fff]/;

async function renderAndSubmit(csv: string) {
  const onClose = vi.fn();
  const onImported = vi.fn();
  render(
    <BulkUploadDialog
      isOpen
      bulkAsyncAllowed
      onClose={onClose}
      onEnqueued={vi.fn()}
      onImported={onImported}
    />,
  );
  fireEvent.change(screen.getByLabelText('rawLabel'), { target: { value: csv } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'submit' }));
  });
  return { onClose, onImported };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('summarizeBulkOutcome', () => {
  it('成功行数取 rollup 的 added + reused，而不是提交行数', () => {
    expect(summarizeBulkOutcome({ added: 2, reused: 1, errorCount: 0 }, [])).toEqual({
      imported: 3,
      failed: 0,
      total: 3,
      tone: 'success',
    });
    expect(summarizeBulkOutcome({ added: 0, reused: 0, errorCount: 4 }, [])).toEqual({
      imported: 0,
      failed: 4,
      total: 4,
      tone: 'failed',
    });
    expect(summarizeBulkOutcome({ added: 2, errorCount: 2 }, [])).toMatchObject({ tone: 'partial' });
  });

  it('总数优先取服务端 rowCount（#629）', () => {
    expect(summarizeBulkOutcome({ added: 1, reused: 0, skipped: 3, errorCount: 3 }, [], 4)).toEqual({
      imported: 1,
      failed: 3,
      total: 4,
      tone: 'partial',
    });
  });

  it('skippedBreakdown 按错误码分组，各组之和恒等于 skipped（#636）', () => {
    const errors = normalizeRowErrors([
      { row: 0, code: 'duplicate_link' },
      { row: 1, code: 'duplicate_link' },
      { row: 2, code: 'validation_failed' },
      { row: 3, code: 'quota_exceeded' },
      { row: 4, code: 'row_failed' },
      { row: 5, code: 'mystery' },
    ]);
    expect(skippedBreakdown(errors, 6)).toEqual({ existing: 2, invalid: 1, quota: 1, failed: 2 });
    // 历史数据 errors 少于 skipped：差额计入保存失败
    expect(skippedBreakdown(errors.slice(0, 1), 3)).toEqual({ existing: 1, invalid: 0, quota: 0, failed: 2 });
  });

  it('normalizeRowErrors 容忍缺字段并按行号排序', () => {
    expect(normalizeRowErrors([{ row: 3, code: 'x' }, { row: 1 }, null])).toEqual([
      { row: 1, code: 'row_failed', message: '' },
      { row: 3, code: 'x', message: '' },
    ]);
  });
});

describe('BulkUploadDialog — 同步结果', () => {
  it('部分成功：提示真实计数、弹窗保持打开并列出未导入的行', async () => {
    // 预览行里 premium 是 field 缺 parent → 客户端就拦下了，这里换成 struct 以模拟服务端结果
    respond({
      rollup: { added: 2, reused: 0, skipped: 2, errorCount: 2 },
      errors: [
        { row: 3, code: 'validation_failed', message: 'canonical must start with a letter' },
        { row: 1, code: 'duplicate_link', message: 'You already have this term in your vocabulary' },
      ],
    });
    const { onClose, onImported } = await renderAndSubmit(CSV.replace('field,premium', 'struct,premium'));

    expect(toast.warning).toHaveBeenCalledWith(
      'syncPartial:{"imported":2,"failed":2,"total":4} (skippedReasons.existing:{"n":1}, skippedReasons.invalid:{"n":1})',
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onImported).toHaveBeenCalledTimes(1);
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    // 先按原因分组计数，再逐行列出；识别不了的服务端原文不显示，只显示错误类别
    expect(items).toEqual([
      'skippedReasons.existing:{"n":1}',
      'skippedReasons.invalid:{"n":1}',
      'rowLabel:{"row":2}: rowErrors.duplicate_link',
      'rowLabel:{"row":4}: rowErrors.validation_failed',
    ]);
    expect(screen.getByRole('button', { name: 'done' })).toBeInTheDocument();
  });

  it('toast 的总数取服务端 rowCount，与「已导入 + 未导入」一致（#629）', async () => {
    respond({
      rowCount: 4,
      processed: 4,
      rollup: { added: 1, reused: 0, skipped: 3, errorCount: 3 },
      errors: [
        { row: 1, code: 'validation_failed', message: 'bad domain' },
        { row: 2, code: 'validation_failed', message: 'bad locale' },
        { row: 3, code: 'duplicate_link', message: 'dup' },
      ],
    });
    await renderAndSubmit(CSV.replace('field,premium', 'struct,premium'));

    expect(toast.warning).toHaveBeenCalledWith(
      'syncPartial:{"imported":1,"failed":3,"total":4} (skippedReasons.existing:{"n":1}, skippedReasons.invalid:{"n":2})',
    );
  });

  it('★未导入按原因分组：已在词汇中 / 无效 / 超配额 / 保存失败（#636）', async () => {
    respond({
      rowCount: 4,
      rollup: { added: 0, reused: 0, skipped: 4, errorCount: 4 },
      errors: [
        { row: 0, code: 'duplicate_link', message: 'dup' },
        { row: 1, code: 'quota_exceeded', message: 'quota' },
        { row: 2, code: 'chunk_failed', message: 'chunk' },
        { row: 3, code: 'validation_failed', message: 'structs[0]: 规范化名称 "Bad Name!" 必须是有效的 ASCII 标识符' },
      ],
    });
    await renderAndSubmit(CSV.replace('field,premium', 'struct,premium'));

    expect(toast.error).toHaveBeenCalledWith(
      'syncNoneImported:{"imported":0,"failed":4,"total":4} (skippedReasons.existing:{"n":1}, ' +
        'skippedReasons.invalid:{"n":1}, skippedReasons.quota:{"n":1}, skippedReasons.failed:{"n":1})',
    );
    expect(screen.getByRole('list', { name: 'skippedReasons.title' })).toBeInTheDocument();
  });

  it('★行级校验失败显示本地化的具体原因，不显示引擎中文原文；未知错误码按保存失败（#634）', async () => {
    respond({
      rollup: { added: 2, reused: 0, skipped: 2, errorCount: 2 },
      errors: [
        { row: 3, code: 'validation_failed', message: 'structs[0]: 规范化名称 "Bad Name!" 必须是有效的 ASCII 标识符' },
        { row: 1, code: 'something_new', message: '内部错误 detail' },
      ],
    });
    await renderAndSubmit(CSV.replace('field,premium', 'struct,premium'));

    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toContain('rowLabel:{"row":4}: rowErrors.validation_failed: errors.validation.invalidCanonical:{"name":"Bad Name!"}');
    expect(items).toContain('rowLabel:{"row":2}: rowErrors.row_failed');
    expect(document.body.textContent).not.toMatch(CJK);
  });

  it('★整批被拒：按错误码本地化，不显示服务端原文（#634）', async () => {
    respond({ error: { code: 'validation_failed', message: 'sync bulk import accepts at most 500 rows' } }, 400);
    await renderAndSubmit(CSV.split('\n').slice(0, 2).join('\n'));
    expect(toast.error).toHaveBeenCalledWith('errors.validation.bulkTooMany:{"limit":"500"}');
  });

  it('★整批被拒且错误码未知：显示通用提示而不是服务端原文（#634）', async () => {
    respond({ error: { code: 'rate_limited', message: 'Too many bulk imports' } }, 429);
    await renderAndSubmit(CSV.split('\n').slice(0, 2).join('\n'));
    expect(toast.error).toHaveBeenCalledWith('errorGeneric');
  });

  it('一行都没导入：报错提示而不是「已导入 N 行」', async () => {
    respond({
      rollup: { added: 0, reused: 0, skipped: 1, errorCount: 1 },
      errors: [{ row: 0, code: 'duplicate_link', message: 'dup' }],
    });
    const { onImported } = await renderAndSubmit(CSV.split('\n').slice(0, 2).join('\n'));

    expect(toast.error).toHaveBeenCalledWith(
      'syncNoneImported:{"imported":0,"failed":1,"total":1} (skippedReasons.existing:{"n":1})',
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(onImported).not.toHaveBeenCalled();
  });

  it('全部成功：按服务端计数提示并关闭弹窗', async () => {
    respond({ rollup: { added: 1, reused: 1, skipped: 0, errorCount: 0 }, errors: [] });
    const { onClose, onImported } = await renderAndSubmit(CSV.split('\n').slice(0, 3).join('\n'));

    expect(toast.success).toHaveBeenCalledWith('syncCompleted:{"count":2}');
    expect(onClose).toHaveBeenCalled();
    expect(onImported).toHaveBeenCalled();
  });
});

describe('BulkUploadDialog — 客户端格式校验（#612）', () => {
  it('domain / locale 不合法的行在提交前就标出，并禁用导入', () => {
    render(<BulkUploadDialog isOpen bulkAsyncAllowed onClose={vi.fn()} onEnqueued={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('rawLabel'), {
      target: {
        value: [
          'domain,locale,kind,canonical,localized',
          'E2E 1026,de,struct,Loan,Kredit',
          'finance,xx_INVALID!!,struct,Loan,Kredit',
        ].join('\n'),
      },
    });
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(['#2: domainInvalid', '#3: localeInvalid']);
    expect(screen.getByRole('button', { name: 'submit' })).toBeDisabled();
  });
});
