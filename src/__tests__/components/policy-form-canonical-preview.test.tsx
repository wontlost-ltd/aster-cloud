// PolicyForm 的词汇规范预览接线（ADR 0058 §8.3）：能力为假时编辑器容器与接入前一致、不接收 LSP 句柄；
// 能力为真且 LSP 声明 canonicalPreview 时才给出开关，打开后在编辑器下方挂载预览窗格。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';

const h = vi.hoisted(() => ({
  dynamicCount: 0,
  // 按 next/dynamic 的声明顺序：0 = MonacoPolicyEditor，1 = CanonicalPreviewPane
  props: [] as Array<Record<string, unknown> | undefined>,
  sidePanel: undefined as Record<string, unknown> | undefined,
  palette: undefined as Record<string, unknown> | undefined,
}));

vi.mock('next/dynamic', () => ({
  __esModule: true,
  default: () => {
    const index = h.dynamicCount++;
    return function DynamicStub(props: Record<string, unknown>) {
      h.props[index] = props;
      return <div data-testid={`dynamic-${index}`} />;
    };
  },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/en/policies/new',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next-intl', () => ({
  useTranslations: () => Object.assign((k: string) => k, { rich: (k: string) => k, raw: (k: string) => k, has: () => true }),
  useLocale: () => 'en',
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock('@/components/policy/policy-form/side-panel', () => ({
  SidePanel: (props: Record<string, unknown>) => {
    h.sidePanel = props;
    return <div data-testid="side-panel" />;
  },
}));
vi.mock('@/components/policy/policy-form/editor-palette', () => ({
  EditorPalette: (props: Record<string, unknown>) => {
    h.palette = props;
    return null;
  },
}));
vi.mock('@/components/policy/policy-form/editor-rail', () => ({ EditorRail: () => null }));
vi.mock('@/components/policy/cnl-syntax-converter-dialog', () => ({ CNLSyntaxConverterDialog: () => null }));
vi.mock('@/components/policy/policy-form/use-is-mobile', () => ({ useIsMobile: () => false }));

import { PolicyForm } from '@/components/policy/policy-form';
import type { StructuredAuthoringProps } from '@/lib/capabilities/types';

const ALLOWED: StructuredAuthoringProps = { allowed: true, sources: [{ kind: 'admin' }] };
const DENIED: StructuredAuthoringProps = { allowed: false, denial: 'not_granted', sources: [] };

function renderForm(structuredAuthoring: StructuredAuthoringProps) {
  return render(
    <PolicyForm
      mode="create"
      uiLocale="en"
      policyId={null}
      initial={{ name: '', description: '', content: 'Module a.\n', isPublic: false, groupId: null, aliasSet: null }}
      title="t"
      subtitle="s"
      onSave={vi.fn(async () => ({ id: 'p1' }))}
      cancelHref="/en/policies"
      detailHrefFor={(id) => `/en/policies/${id}`}
      breadcrumbs={[]}
      structuredAuthoring={structuredAuthoring}
    />,
  );
}

const editorProps = () => h.props[0]!;
const lspHandle = (canonicalPreview: boolean) => ({
  features: { canonicalPreview },
  status: 'connected',
  requestCanonicalPreview: vi.fn(async () => null),
});

beforeEach(() => {
  h.props.length = 0;
  h.sidePanel = undefined;
  h.palette = undefined;
});

describe('PolicyForm 词汇规范预览接线', () => {
  it('能力为假：编辑器直接挂在编辑器卡片里（无额外容器），不接收 LSP 句柄，无开关与面板项', () => {
    renderForm(DENIED);
    const editor = screen.getByTestId('dynamic-0');
    expect(editor.parentElement?.className).toContain('rounded-xl');
    expect(editorProps().onLspChange).toBeUndefined();
    expect(h.sidePanel?.canonicalPreview).toBeNull();
    expect(h.palette?.structuredAuthoring).toBeNull();
  });

  it('能力为真但 LSP 未声明 canonicalPreview：有面板项但没有预览开关', () => {
    renderForm(ALLOWED);
    expect(screen.getByTestId('dynamic-0').parentElement?.className).toContain('min-h-0 flex-1 flex-col');
    act(() => (editorProps().onLspChange as (l: unknown) => void)(lspHandle(false)));
    expect(h.sidePanel?.canonicalPreview).toBeNull();
    const palette = h.palette?.structuredAuthoring as { onToggleCanonicalPreview: unknown };
    expect(palette).toBeTruthy();
    expect(palette.onToggleCanonicalPreview).toBeNull();
  });

  it('能力为真且 LSP 支持：开关打开后在编辑器下方挂载预览窗格，请求来自编辑器的 LSP 句柄', () => {
    renderForm(ALLOWED);
    const handle = lspHandle(true);
    act(() => (editorProps().onLspChange as (l: unknown) => void)(handle));
    const toggle = h.sidePanel?.canonicalPreview as { open: boolean; onToggle: () => void };
    expect(toggle.open).toBe(false);
    expect(screen.queryByTestId('dynamic-1')).toBeNull();
    act(() => toggle.onToggle());
    expect(screen.getByTestId('dynamic-1')).toBeTruthy();
    expect(h.props[1]?.request).toBe(handle.requestCanonicalPreview);
    expect((h.sidePanel?.canonicalPreview as { open: boolean }).open).toBe(true);
    // 面板项同一开关
    act(() => (h.palette?.structuredAuthoring as { onToggleCanonicalPreview: () => void }).onToggleCanonicalPreview());
    expect(screen.queryByTestId('dynamic-1')).toBeNull();
  });

  it('命令面板「新建结构体」打开模型标签并请求新建表单，回执后清除', () => {
    renderForm(ALLOWED);
    act(() => (h.palette?.structuredAuthoring as { onNewStruct: () => void }).onNewStruct());
    expect(h.sidePanel?.initialTab).toBe('model');
    expect(h.sidePanel?.newStructRequested).toBe(true);
    act(() => (h.sidePanel?.onNewStructRequestHandled as () => void)());
    expect(h.sidePanel?.newStructRequested).toBe(false);
  });
});
