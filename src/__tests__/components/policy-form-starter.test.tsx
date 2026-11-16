import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ASTER_POLICY_TEMPLATES } from '@/config/aster-policy-templates';

/**
 * PolicyForm 的入门模板（starter）行为：
 * - 提示条标明这是入门示例与其 CNL 语言，提供「从空白开始」与关闭；
 * - 未改动的入门模板不算未保存修改（不自动保存草稿、不覆盖已有草稿）；
 * - 已有草稿照常提示恢复，恢复后以草稿为准；
 * - 任何改动（手动编辑、AI 写入、模板替换）后提示条消失，入门模板不会再写回编辑器。
 */

const DRAFT_KEY = 'aster:policy-draft:new';
const ZH = ASTER_POLICY_TEMPLATES['zh-CN'];

const h = vi.hoisted(() => ({
  mobile: false,
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() }),
  sidePanelProps: null as null | { starterSource?: string | null },
}));

vi.mock('next/dynamic', () => ({
  __esModule: true,
  default: () =>
    function EditorStub({ value, onChange }: { value: string; onChange: (v: string) => void }) {
      return <textarea data-testid="editor" value={value} onChange={(e) => onChange(e.target.value)} />;
    },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/zh/policies/new',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next-intl', () => ({
  useTranslations: () => Object.assign((k: string) => k, { rich: (k: string) => k, raw: (k: string) => k, has: () => true }),
  useLocale: () => 'zh',
}));
vi.mock('sonner', () => ({ toast: h.toast }));
vi.mock('@/lib/product-events/client', () => ({ trackProductEvent: vi.fn() }));
vi.mock('@/components/policy/policy-form/side-panel', async () => {
  const { POLICY_EXAMPLES } = await import('@/data/policy-examples');
  const loan = POLICY_EXAMPLES.find((e) => e.id === 'loan-evaluation')!;
  return {
    SidePanel: (props: {
      starterSource?: string | null;
      onApplyContent: (body: string) => void;
      onApplyTemplate: (tpl: unknown) => void;
    }) => {
      h.sidePanelProps = props;
      return (
        <>
          <button type="button" onClick={() => props.onApplyContent('模块 智能.生成。')}>
            ai-apply
          </button>
          <button type="button" onClick={() => props.onApplyTemplate(loan)}>
            template-loan
          </button>
        </>
      );
    },
  };
});
vi.mock('@/components/policy/policy-form/editor-palette', () => ({ EditorPalette: () => null }));
vi.mock('@/components/policy/policy-form/editor-rail', () => ({ EditorRail: () => null }));
vi.mock('@/components/policy/cnl-syntax-converter-dialog', () => ({ CNLSyntaxConverterDialog: () => null }));
vi.mock('@/components/policy/policy-form/use-is-mobile', () => ({ useIsMobile: () => h.mobile }));

import { PolicyForm } from '@/components/policy/policy-form';

function renderForm({ starter = true, content = ZH }: { starter?: boolean; content?: string } = {}) {
  return render(
    <PolicyForm
      mode="create"
      uiLocale="zh"
      policyId={null}
      initial={{ name: '', description: '', content, isPublic: false, groupId: null, aliasSet: null }}
      starter={starter}
      title="t"
      subtitle="s"
      onSave={vi.fn()}
      cancelHref="/zh/policies"
      detailHrefFor={(id) => `/zh/policies/${id}`}
      breadcrumbs={[]}
    />,
  );
}

/** 触发一次 beforeunload，返回离开确认是否会弹出（未保存修改守卫调用了 preventDefault）。 */
function leaveWarns(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

const editorValue = () => (screen.getByTestId('editor') as HTMLTextAreaElement).value;
/** 越过自动保存的 1s 节流窗口。 */
const passAutosaveWindow = () => act(() => new Promise((r) => setTimeout(r, 1200)));

describe('PolicyForm 入门模板', () => {
  // jsdom 未实现 <dialog>.showModal/close（模板替换确认用 ConfirmDialog）：补最小桩，只切换 open 属性。
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  });
  beforeEach(() => {
    vi.clearAllMocks();
    h.mobile = false;
    h.sidePanelProps = null;
    window.localStorage.clear();
  });
  afterEach(() => window.localStorage.clear());

  it('★显示入门提示条，标明模板的 CNL 语言', () => {
    renderForm();
    const hint = screen.getByTestId('policy-starter-hint');
    expect(hint.textContent).toContain('ZH-CN');
    expect(editorValue()).toBe(ZH);
    expect(screen.getByTestId('policy-starter-blank')).toBeTruthy();
  });

  it('★未改动的入门模板不自动保存草稿', async () => {
    renderForm();
    await passAutosaveWindow();
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('★「从空白开始」清空编辑器、隐藏提示条，且空白不算未保存修改', async () => {
    renderForm();
    fireEvent.click(screen.getByTestId('policy-starter-blank'));
    expect(editorValue()).toBe('');
    expect(screen.queryByTestId('policy-starter-hint')).toBeNull();
    await passAutosaveWindow();
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('★未改动的入门模板 / 从空白开始都不触发离开确认；手动改动后触发', () => {
    renderForm();
    expect(leaveWarns()).toBe(false);
    fireEvent.click(screen.getByTestId('policy-starter-blank'));
    expect(leaveWarns()).toBe(false);
    fireEvent.change(screen.getByTestId('editor'), { target: { value: '模块 我的.策略。' } });
    expect(leaveWarns()).toBe(true);
  });

  it('侧栏模板替换入门模板（确认后）：内容为所选模板、提示条消失、不再视为入门模板', async () => {
    const { POLICY_EXAMPLES } = await import('@/data/policy-examples');
    const loanZh = POLICY_EXAMPLES.find((e) => e.id === 'loan-evaluation')!.sources['zh-CN'];
    renderForm();
    fireEvent.click(screen.getByText('template-loan'));
    fireEvent.click(screen.getByRole('button', { name: 'replace' }));
    expect(editorValue()).toBe(loanZh);
    expect(screen.queryByTestId('policy-starter-hint')).toBeNull();
    expect(h.sidePanelProps?.starterSource).toBeNull();
  });

  it('关闭提示条只收起提示，保留入门模板内容', () => {
    renderForm();
    fireEvent.click(screen.getByTestId('policy-starter-dismiss'));
    expect(screen.queryByTestId('policy-starter-hint')).toBeNull();
    expect(editorValue()).toBe(ZH);
  });

  it('★已有草稿：照常提示恢复、不被入门模板覆盖；恢复后以草稿为准', async () => {
    const draft = { v: 2, savedAt: Date.now(), name: '我的策略', description: '', content: '模块 我的.草稿。', isPublic: false, groupId: null, aliasSet: null };
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    renderForm();

    expect(h.toast).toHaveBeenCalledTimes(1);
    await passAutosaveWindow();
    expect(JSON.parse(window.localStorage.getItem(DRAFT_KEY)!).content).toBe('模块 我的.草稿。');

    const options = h.toast.mock.calls[0][1] as { action: { onClick: () => void } };
    act(() => options.action.onClick());
    expect(editorValue()).toBe('模块 我的.草稿。');
    expect(screen.queryByTestId('policy-starter-hint')).toBeNull();
  });

  it('手动编辑后提示条消失（之后不再是入门模板）', () => {
    renderForm();
    fireEvent.change(screen.getByTestId('editor'), { target: { value: `${ZH}\n` } });
    expect(screen.queryByTestId('policy-starter-hint')).toBeNull();
  });

  it('★未改动的入门模板作为 starterSource 传给侧栏（AI 不把它当用户源码）；AI 写入后不再传', () => {
    renderForm();
    expect(h.sidePanelProps?.starterSource).toBe(ZH);
    fireEvent.click(screen.getByText('ai-apply'));
    expect(editorValue()).toBe('模块 智能.生成。');
    expect(h.sidePanelProps?.starterSource).toBeNull();
    expect(screen.queryByTestId('policy-starter-hint')).toBeNull();
  });

  it('非入门模板的新建（如文档深链）不显示提示条', () => {
    renderForm({ starter: false, content: 'Module demo.' });
    expect(screen.queryByTestId('policy-starter-hint')).toBeNull();
    expect(h.sidePanelProps?.starterSource).toBeNull();
  });

  it('手机只读视图：显示提示但不提供「从空白开始」', () => {
    h.mobile = true;
    renderForm();
    expect(screen.getByTestId('policy-starter-hint')).toBeTruthy();
    expect(screen.queryByTestId('policy-starter-blank')).toBeNull();
  });
});
