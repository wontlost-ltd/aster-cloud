import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * 保存时作者词汇非法（400 vocabulary_scope_invalid）→ 指出出错词条并链接到词汇页；
 * 词汇暂时无法加载（503 vocabulary_unavailable）→ 与编译服务不可用不同的提示（ADR 0051）。
 */

const h = vi.hoisted(() => ({
  toastError: vi.fn(),
  translate: vi.fn((key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join('|')})` : key,
  ),
}));

vi.mock('next/dynamic', () => ({ __esModule: true, default: () => () => null }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/de/policies/p1/edit',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next-intl', () => ({
  useTranslations: () => Object.assign(h.translate, { rich: (k: string) => k, raw: (k: string) => k, has: () => true }),
  useLocale: () => 'de',
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: h.toastError, info: vi.fn() }) }));
vi.mock('@/components/policy/policy-form/side-panel', () => ({ SidePanel: () => null }));
vi.mock('@/components/policy/policy-form/editor-palette', () => ({ EditorPalette: () => null }));
vi.mock('@/components/policy/policy-form/editor-rail', () => ({ EditorRail: () => null }));
vi.mock('@/components/policy/cnl-syntax-converter-dialog', () => ({ CNLSyntaxConverterDialog: () => null }));
vi.mock('@/components/policy/policy-form/use-is-mobile', () => ({ useIsMobile: () => false }));

import { PolicyForm, type PolicySaveError } from '@/components/policy/policy-form';

function renderForm(onSave: () => Promise<{ id: string } | PolicySaveError>) {
  return render(
    <PolicyForm
      mode="edit"
      uiLocale="de"
      policyId="p1"
      initial={{ name: 'n', description: '', content: 'Module a.', isPublic: false, groupId: null, aliasSet: null }}
      title="Edit"
      subtitle="s"
      onSave={onSave}
      cancelHref="/de/policies/p1"
      detailHrefFor={(id) => `/de/policies/${id}`}
      breadcrumbs={[]}
    />,
  );
}

describe('PolicyForm 词汇保存错误', () => {
  beforeEach(() => vi.clearAllMocks());

  it('vocabulary_scope_invalid 带 term → 提示出错词条并链接到词汇页', async () => {
    renderForm(async () => ({
      message: 'field_parent_required: 字段 "alter" 缺少 parent',
      code: 'vocabulary_scope_invalid',
      reason: 'field_parent_required',
      term: 'alter',
      kind: 'field',
    }));

    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    expect(h.toastError).toHaveBeenCalledWith('saveFailed', {
      description: 'saveErrorCodes.vocabulary_scope_parent_required_term(alter)',
    });
    const banner = screen.getByRole('alert');
    expect(banner.textContent).toContain('saveErrorCodes.vocabulary_scope_parent_required_term(alter)');
    expect(banner.textContent).not.toContain('缺少');
    const link = screen.getByRole('link', { name: 'openVocabulary' });
    expect(link.getAttribute('href')).toBe('/de/domain-vocabularies');
  });

  // #650：缺 parent 与字面量冲突各用自己的文案，不再共用一段同时讲两件事的通用说明
  it.each([
    ['member_parent_required', 'Hoch', 'saveErrorCodes.vocabulary_scope_parent_required_term(Hoch)'],
    ['member_parent_required', undefined, 'saveErrorCodes.vocabulary_scope_parent_required'],
    ['literal_conflict', 'hoch', 'saveErrorCodes.vocabulary_scope_literal_conflict_term(hoch)'],
    ['literal_conflict', undefined, 'saveErrorCodes.vocabulary_scope_literal_conflict'],
    ['something_new', 'x', 'saveErrorCodes.vocabulary_scope_invalid_term(x)'],
  ])('reason=%s term=%s → %s', async (reason, term, expected) => {
    renderForm(async () => ({ message: 'x', code: 'vocabulary_scope_invalid', reason, term }));
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    expect(h.toastError).toHaveBeenCalledWith('saveFailed', { description: expected });
  });

  it('vocabulary_scope_invalid 无 term → 通用提示，仍链接到词汇页', async () => {
    renderForm(async () => ({ message: 'x', code: 'vocabulary_scope_invalid' }));
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    expect(h.toastError).toHaveBeenCalledWith('saveFailed', { description: 'saveErrorCodes.vocabulary_scope_invalid' });
    expect(screen.getByRole('link', { name: 'openVocabulary' })).toBeTruthy();
  });

  it('vocabulary_unavailable → 与 compile_unavailable 不同的提示', async () => {
    renderForm(async () => ({ message: 'Domain vocabulary could not be loaded.', code: 'vocabulary_unavailable' }));
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    expect(h.toastError).toHaveBeenCalledWith('saveFailed', { description: 'saveErrorCodes.vocabulary_unavailable' });
    expect(screen.getByRole('alert').textContent).toContain('saveErrorCodes.vocabulary_unavailable');
  });
});
