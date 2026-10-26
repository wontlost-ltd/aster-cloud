import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * #613：跨 kind 重复别名不能静默拦截保存——须打开别名面板并给出本地化说明。
 * #609：服务端 alias_invalid 按错误码本地化，不展示中文诊断原文。
 */

const h = vi.hoisted(() => ({
  toastError: vi.fn(),
  translate: vi.fn((key: string, values?: Record<string, unknown>) =>
    values && key.startsWith('errors.') ? `${key}(${values.alias}|${values.kind}|${values.otherKind})` : key,
  ),
}));

vi.mock('next/dynamic', () => ({ __esModule: true, default: () => () => null }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/en/policies/p1/edit',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next-intl', () => ({
  useTranslations: () => Object.assign(h.translate, { rich: (k: string) => k, raw: (k: string) => k, has: () => true }),
  useLocale: () => 'en',
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: h.toastError, info: vi.fn() }) }));
vi.mock('@/components/policy/policy-form/side-panel', () => ({
  SidePanel: ({ initialTab }: { initialTab?: string }) => <div data-testid="side-panel">{initialTab}</div>,
}));
vi.mock('@/components/policy/policy-form/editor-palette', () => ({ EditorPalette: () => null }));
vi.mock('@/components/policy/policy-form/editor-rail', () => ({ EditorRail: () => null }));
vi.mock('@/components/policy/cnl-syntax-converter-dialog', () => ({ CNLSyntaxConverterDialog: () => null }));
vi.mock('@/components/policy/policy-form/use-is-mobile', () => ({ useIsMobile: () => false }));

import { PolicyForm } from '@/components/policy/policy-form';

type SaveResult = { id: string } | { message: string; code?: string };

function renderForm(aliasSet: Record<string, string[]> | null, onSave: () => Promise<SaveResult>) {
  return render(
    <PolicyForm
      mode="edit"
      uiLocale="en"
      policyId="p1"
      initial={{ name: 'n', description: '', content: 'Module a.', isPublic: false, groupId: null, aliasSet }}
      title="Edit"
      subtitle="s"
      onSave={onSave}
      cancelHref="/en/policies/p1"
      detailHrefFor={(id) => `/en/policies/${id}`}
      breadcrumbs={[]}
    />,
  );
}

describe('PolicyForm 别名保存提示', () => {
  beforeEach(() => vi.clearAllMocks());

  it('#613：跨 kind 重复别名 → 不提交，打开别名面板并 toast 本地化原因', async () => {
    const onSave = vi.fn().mockResolvedValue({ id: 'p1' });
    renderForm({ TIMES: ['multiplied by'], MODULO: ['multiplied by'] }, onSave);

    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    expect(onSave).not.toHaveBeenCalled();
    expect(h.toastError).toHaveBeenCalledWith('aliasesInvalidBeforeSaving', {
      description: 'errors.duplicate(multiplied by|kinds.modulo|kinds.times)',
    });
    expect(screen.getByTestId('side-panel').textContent).toBe('aliases');
  });

  it('#609：服务端 alias_invalid → 本地化提示并打开别名面板，不显示原文', async () => {
    const onSave = vi.fn().mockResolvedValue({
      message: 'CNL 解析失败: 用户自定义别名校验失败: 不允许为结构词 IF 自定义别名',
      code: 'alias_invalid',
    });
    renderForm({ TIMES: ['multiplied by'] }, onSave);

    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(h.toastError).toHaveBeenCalledWith('saveFailed', { description: 'saveErrorCodes.alias_invalid' });
    expect(screen.getByTestId('side-panel').textContent).toBe('aliases');
    const banner = screen.getByRole('alert');
    expect(banner.textContent).toContain('saveErrorCodes.alias_invalid');
    expect(banner.textContent).not.toContain('别名');
  });
});
