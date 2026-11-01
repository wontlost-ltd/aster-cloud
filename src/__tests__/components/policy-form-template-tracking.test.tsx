import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

/**
 * 需求验证埋点：新建策略时选模板记 template_selected（只带模板 id 与入口），编辑已有策略不记。
 */

const h = vi.hoisted(() => ({ track: vi.fn() }));

vi.mock('@/lib/product-events/client', () => ({ trackProductEvent: h.track }));
vi.mock('next/dynamic', () => ({ __esModule: true, default: () => () => null }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/en/policies/new',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next-intl', () => ({
  useTranslations: () => Object.assign((k: string) => k, { rich: (k: string) => k, raw: (k: string) => k, has: () => true }),
  useLocale: () => 'en',
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() }) }));
vi.mock('@/components/policy/policy-form/side-panel', async () => {
  const { POLICY_EXAMPLES } = await import('@/data/policy-examples');
  const tpl = POLICY_EXAMPLES.find((e) => e.id === 'auto-insurance-quote')!;
  return {
    SidePanel: ({ onApplyTemplate }: { onApplyTemplate: (t: unknown) => void }) => (
      <button type="button" onClick={() => onApplyTemplate(tpl)}>apply-template</button>
    ),
  };
});
vi.mock('@/components/policy/policy-form/editor-palette', async () => {
  const { POLICY_EXAMPLES } = await import('@/data/policy-examples');
  const tpl = POLICY_EXAMPLES.find((e) => e.id === 'loan-evaluation')!;
  return {
    EditorPalette: ({ onInsertTemplate }: { onInsertTemplate: (t: unknown) => void }) => (
      <button type="button" onClick={() => onInsertTemplate(tpl)}>insert-template</button>
    ),
  };
});
vi.mock('@/components/policy/policy-form/editor-rail', () => ({ EditorRail: () => null }));
vi.mock('@/components/policy/cnl-syntax-converter-dialog', () => ({ CNLSyntaxConverterDialog: () => null }));
vi.mock('@/components/policy/policy-form/use-is-mobile', () => ({ useIsMobile: () => false }));

import { PolicyForm } from '@/components/policy/policy-form';

function renderForm(mode: 'create' | 'edit') {
  return render(
    <PolicyForm
      mode={mode}
      uiLocale="en"
      policyId={mode === 'edit' ? 'p1' : null}
      initial={{ name: '', description: '', content: '', isPublic: false, groupId: null, aliasSet: null }}
      title="t"
      subtitle="s"
      onSave={vi.fn()}
      cancelHref="/en/policies"
      detailHrefFor={(id) => `/en/policies/${id}`}
      breadcrumbs={[]}
    />,
  );
}

describe('PolicyForm 模板选择埋点', () => {
  beforeEach(() => vi.clearAllMocks());

  it('新建时从侧栏模板替换 → picker', () => {
    renderForm('create');
    fireEvent.click(screen.getByText('apply-template'));
    expect(h.track).toHaveBeenCalledWith('template_selected', { templateId: 'auto-insurance-quote', source: 'picker' });
  });

  it('新建时从命令面板插入 → palette', () => {
    renderForm('create');
    fireEvent.click(screen.getByText('insert-template'));
    expect(h.track).toHaveBeenCalledWith('template_selected', { templateId: 'loan-evaluation', source: 'palette' });
  });

  it('编辑已有策略时不记（编辑模式侧栏默认收起，经命令面板验证）', () => {
    renderForm('edit');
    fireEvent.click(screen.getByText('insert-template'));
    expect(h.track).not.toHaveBeenCalled();
  });
});
