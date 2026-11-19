// 能力为假时编辑器 DOM 与引入显示排版之前逐字节一致（ADR 0058 P2 Global Constraints，计划 T10）。
// 快照在未改动的 main 上生成；之后即使下发了 layout 相关 props（活跃版本带排版），能力为假的 DOM 也不得变化。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import enBase from '@aster-cloud/ui-messages/en-US.json';
import { IntlClientProvider } from '@/i18n/intl-client-provider';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';

vi.mock('next/dynamic', () => ({
  __esModule: true,
  default: () =>
    function DynamicStub() {
      return <div data-testid="dynamic-stub" />;
    },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/en/policies/p1/edit',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() }) }));
vi.mock('lucide-react', async () => ({ ...(await vi.importActual<Record<string, unknown>>('lucide-react')) }));
vi.mock('@/components/policy/ai-assistant-panel', () => ({ AIAssistantPanel: () => <div data-testid="legacy-ai" /> }));
vi.mock('@/components/policy/cnl-syntax-reference-panel', () => ({ CNLSyntaxReferencePanel: () => null }));
vi.mock('@/components/policy/policy-alias-panel', () => ({ PolicyAliasPanel: () => null }));
vi.mock('@/components/policy/cnl-syntax-converter-dialog', () => ({ CNLSyntaxConverterDialog: () => null }));
vi.mock('@/components/policy/policy-form/use-is-mobile', () => ({ useIsMobile: () => false }));

import { PolicyForm } from '@/components/policy/policy-form';
import type { ComponentProps } from 'react';

const messages = deepMergeMessages(enBase as Record<string, unknown>, DEMO_SUPPLEMENT.en);
const SOURCE = 'Module demo.layout.\n\nRule decide given amount as Int, produce Int:\n  Return amount.\n';
const DENIED = { allowed: false as const, denial: 'not_granted' as const, sources: [] };

function renderForm(extra: Record<string, unknown>) {
  const props = {
    mode: 'edit' as const,
    uiLocale: 'en',
    policyId: 'p1',
    initial: { name: 'n', description: '', content: SOURCE, isPublic: false, groupId: null, aliasSet: null },
    title: 'Edit',
    subtitle: 's',
    onSave: vi.fn(async () => ({ id: 'p1' })),
    cancelHref: '/en/policies/p1',
    detailHrefFor: (id: string) => `/en/policies/${id}`,
    breadcrumbs: [],
    structuredAuthoring: DENIED,
    ...extra,
  };
  return render(
    <IntlClientProvider locale="en" messages={messages as never}>
      <PolicyForm {...(props as unknown as ComponentProps<typeof PolicyForm>)} />
    </IntlClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(min-width: 1024px)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PolicyForm 能力为假的 DOM', () => {
  it('侧栏收起时与 main 一致', () => {
    const { container } = renderForm({});
    expect(container.innerHTML).toMatchSnapshot();
  });

  it('活跃版本带排版、下发了 layout props 时仍与 main 一致', () => {
    const { container } = renderForm({
      hasActiveLayout: true,
      initialLayout: { v: 1, spans: [{ text: SOURCE }] },
      initialLayoutInconsistent: false,
    });
    expect(container.innerHTML).toMatchSnapshot();
  });

  it('打开侧栏（模板标签）后与 main 一致', () => {
    const { container, getAllByRole } = renderForm({ hasActiveLayout: true });
    const templates = getAllByRole('button').find((b) => b.getAttribute('aria-label') === (messages as { policies: { form: { sidePanelTemplates: string } } }).policies.form.sidePanelTemplates);
    act(() => templates!.click());
    expect(container.innerHTML).toMatchSnapshot();
  });
});
