import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * #627：德语界面编辑英文策略时，状态栏显示 CNL DE-DE、别名面板规范列显示德语关键词。
 * 编辑器的 CNL 语言必须是策略的语言（源码识别 / 已记录 locale），不是界面语言；
 * 保存请求提交的 locale 与之一致。
 */

const h = vi.hoisted(() => ({
  translate: vi.fn((key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
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
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
/** 侧栏换成探针：暴露别名面板等子面板拿到的 CNL 语言。 */
vi.mock('@/components/policy/policy-form/side-panel', () => ({
  SidePanel: ({ cnlLocale }: { cnlLocale: string }) => <div data-testid="side-panel" data-cnl-locale={cnlLocale} />,
}));
vi.mock('@/components/policy/policy-form/editor-palette', () => ({ EditorPalette: () => null }));
/** 左侧栏换成一个按钮：点击打开别名面板（编辑模式下侧栏默认收起）。 */
vi.mock('@/components/policy/policy-form/editor-rail', () => ({
  EditorRail: ({ onSelect }: { onSelect: (tab: string) => void }) => (
    <button type="button" onClick={() => onSelect('aliases')}>open-aliases</button>
  ),
}));
vi.mock('@/components/policy/cnl-syntax-converter-dialog', () => ({ CNLSyntaxConverterDialog: () => null }));
vi.mock('@/components/policy/policy-form/use-is-mobile', () => ({ useIsMobile: () => false }));

import { PolicyForm, type PolicySaveContext } from '@/components/policy/policy-form';

const ENGLISH = `Module e2e.alias.

Rule score given age as Int, produce Int:
  If age at least 18:
    Return 1.
  Return 0.
`;
const GERMAN = `Modul e2e.vocab.

Definiere Fahrer hat alter als Ganzzahl.
`;

function renderForm(opts: {
  mode: 'create' | 'edit';
  content: string;
  policyCnlLocale?: string | null;
}) {
  const onSave = vi.fn(async (_fields: unknown, _ctx: PolicySaveContext) => ({ id: 'p1' }));
  render(
    <PolicyForm
      mode={opts.mode}
      uiLocale="de"
      policyCnlLocale={opts.policyCnlLocale}
      policyId={opts.mode === 'edit' ? 'p1' : null}
      initial={{ name: 'n', description: '', content: opts.content, isPublic: false, groupId: null, aliasSet: null }}
      title="t"
      subtitle="s"
      onSave={onSave}
      cancelHref="/de/policies"
      detailHrefFor={(id) => `/de/policies/${id}`}
      breadcrumbs={[]}
    />,
  );
  return { onSave };
}

function panelLocale(): string | null {
  if (!screen.queryByTestId('side-panel')) fireEvent.click(screen.getByRole('button', { name: 'open-aliases' }));
  return screen.getByTestId('side-panel').getAttribute('data-cnl-locale');
}

function statusLocale(): string {
  const bar = screen.getByTestId('policy-status-bar');
  const match = /statusLocale:(\{[^}]*\})/.exec(bar.textContent ?? '');
  return (JSON.parse(match![1]) as { locale: string }).locale;
}

describe('PolicyForm 的 CNL 语言跟随策略而非界面语言（#627）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('德语界面编辑英文策略：状态栏 EN-US，别名面板拿到 en-US，保存提交 en-US', async () => {
    const { onSave } = renderForm({ mode: 'edit', content: ENGLISH, policyCnlLocale: 'en-US' });

    expect(statusLocale()).toBe('EN-US');
    expect(panelLocale()).toBe('en-US');

    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][1]).toEqual({ locale: 'en-US' });
  });

  it('已记录 locale 被界面语言污染（de-DE）但源码明确是英文：以源码为准', () => {
    renderForm({ mode: 'edit', content: ENGLISH, policyCnlLocale: 'de-DE' });
    expect(statusLocale()).toBe('EN-US');
  });

  it('德语策略照常显示 DE-DE', () => {
    renderForm({ mode: 'edit', content: GERMAN, policyCnlLocale: 'de-DE' });
    expect(statusLocale()).toBe('DE-DE');
  });

  it('源码无法高置信识别时用已记录 locale（如 hi-IN）', () => {
    renderForm({ mode: 'edit', content: 'x', policyCnlLocale: 'hi-IN' });
    expect(statusLocale()).toBe('HI-IN');
    expect(panelLocale()).toBe('hi-IN');
  });

  it('新建英文策略（德语界面）：EN-US，保存提交 en-US 而非界面语言', async () => {
    const { onSave } = renderForm({ mode: 'create', content: ENGLISH });
    expect(statusLocale()).toBe('EN-US');
    expect(panelLocale()).toBe('en-US');

    fireEvent.click(screen.getByRole('button', { name: 'create' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][1]).toEqual({ locale: 'en-US' });
  });

  it('新建空策略：沿用界面语言对应的 CNL 语言', () => {
    renderForm({ mode: 'create', content: '' });
    expect(statusLocale()).toBe('DE-DE');
  });
});
