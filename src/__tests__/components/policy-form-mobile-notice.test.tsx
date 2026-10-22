import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * F30：手机宽度下编辑器降级为只读视图（无保存、无侧栏），须说明「编辑需要更宽的屏幕」。
 */

const mobile = vi.hoisted(() => ({ value: true }));

vi.mock('next/dynamic', () => ({ __esModule: true, default: () => () => null }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/zh/policies/p1/edit',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next-intl', () => ({
  useTranslations: () => Object.assign((k: string) => k, { rich: (k: string) => k, raw: (k: string) => k, has: () => true }),
  useLocale: () => 'zh',
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock('@/components/policy/policy-form/side-panel', () => ({ SidePanel: () => null }));
vi.mock('@/components/policy/policy-form/editor-palette', () => ({ EditorPalette: () => null }));
vi.mock('@/components/policy/policy-form/editor-rail', () => ({ EditorRail: () => null }));
vi.mock('@/components/policy/cnl-syntax-converter-dialog', () => ({ CNLSyntaxConverterDialog: () => null }));
vi.mock('@/components/policy/policy-form/use-is-mobile', () => ({ useIsMobile: () => mobile.value }));

import { PolicyForm } from '@/components/policy/policy-form';

function renderForm() {
  return render(
    <PolicyForm
      mode="edit"
      uiLocale="zh"
      policyId="p1"
      initial={{ name: 'n', description: '', content: 'Module a.', isPublic: false, groupId: null, aliasSet: null }}
      title="编辑策略"
      subtitle="s"
      onSave={async () => ({ id: 'p1' })}
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
});
