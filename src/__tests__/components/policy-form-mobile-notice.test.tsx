import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * F30：手机宽度下编辑器降级为只读视图（无保存、无侧栏），须说明「编辑需要更宽的屏幕」。
 */

const mobile = vi.hoisted(() => ({ value: true, toastError: vi.fn(), translate: vi.fn((key: string) => key) }));

vi.mock('next/dynamic', () => ({ __esModule: true, default: () => () => null }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/zh/policies/p1/edit',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next-intl', () => ({
  useTranslations: () => Object.assign(mobile.translate, { rich: (k: string) => k, raw: (k: string) => k, has: () => true }),
  useLocale: () => 'zh',
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: mobile.toastError, info: vi.fn() }) }));
vi.mock('@/components/policy/policy-form/side-panel', () => ({
  SidePanel: ({ compileState, compileDiagnostics, initialTab }: { compileState?: string; compileDiagnostics?: Array<{ code?: string; message: string; startLine: number }>; initialTab?: string }) => (
    <div data-testid="problems-panel">
      {initialTab}:{compileState}:{compileDiagnostics?.map((d) => `${d.code}@${d.startLine}:${d.message}`).join('|')}
    </div>
  ),
}));
vi.mock('@/components/policy/policy-form/editor-palette', () => ({ EditorPalette: () => null }));
vi.mock('@/components/policy/policy-form/editor-rail', () => ({ EditorRail: () => null }));
vi.mock('@/components/policy/cnl-syntax-converter-dialog', () => ({ CNLSyntaxConverterDialog: () => null }));
vi.mock('@/components/policy/policy-form/use-is-mobile', () => ({ useIsMobile: () => mobile.value }));

import { PolicyForm } from '@/components/policy/policy-form';

function renderForm(onSave: () => Promise<{ id: string } | { message: string; code?: string; diagnostics?: Array<{ severity: 'error'; code: string; message: string; startLine: number; startColumn: number }> }> = async () => ({ id: 'p1' })) {
  return render(
    <PolicyForm
      mode="edit"
      uiLocale="zh"
      policyId="p1"
      initial={{ name: 'n', description: '', content: 'Module a.', isPublic: false, groupId: null, aliasSet: null }}
      title="编辑策略"
      subtitle="s"
      onSave={onSave}
      cancelHref="/zh/policies/p1"
      detailHrefFor={(id) => `/zh/policies/${id}`}
      breadcrumbs={[]}
    />,
  );
}

describe('PolicyForm 手机只读提示', () => {
  it('★手机宽度：显示只读说明，且不显示保存按钮', () => {
    mobile.value = true;
    renderForm();
    const notice = screen.getByTestId('policy-mobile-readonly-notice');
    expect(notice.textContent).toBe('mobileReadOnlyNotice');
    expect(notice.getAttribute('role')).toBe('note');
    expect(screen.queryByRole('button', { name: 'save' })).toBeNull();
  });

  it('桌面宽度：不显示只读说明', () => {
    mobile.value = false;
    renderForm();
    expect(screen.queryByTestId('policy-mobile-readonly-notice')).toBeNull();
  });

  it('服务端保存失败带诊断时打开 Problems 并用本地化摘要 toast', async () => {
    mobile.value = false;
    const onSave = vi.fn().mockResolvedValue({
      message: 'server text',
      code: 'compile_error',
      diagnostics: [{ severity: 'error', code: 'E001', message: 'Unexpected token', startLine: 4, startColumn: 7 }],
    });
    renderForm(onSave);

    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(await screen.findByText(/problems:error:E001@4:Unexpected token/)).toBeTruthy();
    expect(mobile.translate).toHaveBeenCalledWith('saveFailedWithDiagnostics', {
      count: 1,
      line: 4,
      message: 'Unexpected token',
    });
    expect(mobile.toastError).toHaveBeenCalledWith('saveFailedWithDiagnostics');
    expect(screen.getByRole('alert').textContent).toContain('saveErrorCodes.compile_error');
    expect(screen.getByRole('alert').textContent).not.toContain('server text');
  });
});
