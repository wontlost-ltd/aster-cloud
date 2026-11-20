// PolicyForm 的显示排版接线（ADR 0058 §7.5，计划 T10 并排视图、T11 保存三态与丢弃提示，裁决 R13）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { displayToCanonical, type PolicyLayout } from '@aster-cloud/aster-lang-ts/layout';
import { identityLayout, markStructural, offsetAt, positionAt, projectCanonicalRange } from '@/lib/policy-layout/edit-ops';
import { LAYOUT_ERROR_CASES, LAYOUT_SOURCE, LAYOUT_VALID_CASE } from '../../fixtures/layout-error-cases';

/** 带参数的文案以 `key{a=1,b=2}` 形式展开，测试据此核对行列与上限名。 */
function format(key: string, values?: Record<string, unknown>): string {
  if (!values) return key;
  return `${key}{${Object.entries(values).map(([k, v]) => `${k}=${String(v)}`).join(',')}}`;
}

const h = vi.hoisted(() => ({
  dynamicCount: 0,
  // next/dynamic 的声明顺序：0 = MonacoPolicyEditor，1 = CanonicalPreviewPane
  props: [] as Array<Record<string, unknown> | undefined>,
  sidePanel: undefined as Record<string, unknown> | undefined,
  display: undefined as Record<string, unknown> | undefined,
  rail: undefined as Record<string, unknown> | undefined,
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
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
  usePathname: () => '/en/policies/p1/edit',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next-intl', () => ({
  useTranslations: () => Object.assign(format, { rich: (k: string) => k, raw: (k: string) => k, has: () => true }),
  useLocale: () => 'en',
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), h.toast) }));
vi.mock('@/components/policy/policy-form/side-panel', () => ({
  SidePanel: (props: Record<string, unknown>) => {
    h.sidePanel = props;
    return <div data-testid="side-panel">{props.initialTab as string}</div>;
  },
}));
vi.mock('@/components/policy/layout/layout-display-view', () => ({
  LayoutDisplayView: (props: Record<string, unknown>) => {
    h.display = props;
    return <div data-testid="layout-display-view" />;
  },
}));
vi.mock('@/components/policy/policy-form/editor-palette', () => ({ EditorPalette: () => null }));
vi.mock('@/components/policy/policy-form/editor-rail', () => ({
  EditorRail: (props: Record<string, unknown>) => {
    h.rail = props;
    return null;
  },
}));
vi.mock('@/components/policy/cnl-syntax-converter-dialog', () => ({ CNLSyntaxConverterDialog: () => null }));
vi.mock('@/components/policy/policy-form/use-is-mobile', () => ({ useIsMobile: () => false }));

import { PolicyForm, type LayoutDraft, type PolicySaveContext } from '@/components/policy/policy-form';
import type { StructuredAuthoringProps } from '@/lib/capabilities/types';
import { jingyesiShowcaseExample } from '@/data/policy-example-showcase';
import { layoutSideBySidePreference } from '@/lib/preferences/layout-side-by-side';

const ALLOWED: StructuredAuthoringProps = { allowed: true, sources: [{ kind: 'admin' }] };
const DENIED: StructuredAuthoringProps = { allowed: false, denial: 'not_granted', sources: [] };
const VALID = LAYOUT_VALID_CASE.layout as PolicyLayout;

type SaveFn = (fields: unknown, ctx: PolicySaveContext) => Promise<unknown>;

function renderForm(opts: {
  structuredAuthoring?: StructuredAuthoringProps;
  onSave?: SaveFn;
  initialLayout?: PolicyLayout | null;
  hasActiveLayout?: boolean;
  content?: string;
}) {
  const onSave = vi.fn(opts.onSave ?? (async () => ({ id: 'p1' })));
  render(
    <PolicyForm
      mode="edit"
      uiLocale="en"
      policyId="p1"
      initial={{ name: 'n', description: '', content: opts.content ?? LAYOUT_SOURCE, isPublic: false, groupId: null, aliasSet: null }}
      title="Edit"
      subtitle="s"
      onSave={onSave as never}
      cancelHref="/en/policies/p1"
      detailHrefFor={(id) => `/en/policies/${id}`}
      breadcrumbs={[]}
      structuredAuthoring={opts.structuredAuthoring ?? ALLOWED}
      initialLayout={opts.initialLayout ?? null}
      hasActiveLayout={opts.hasActiveLayout ?? false}
    />,
  );
  // 编辑模式下侧栏默认收起：经 rail 打开「AI」标签，让 SidePanel 挂载（不预设为 layout，失败用例才能看出是否被切过去）
  act(() => (h.rail!.onSelect as (tab: string) => void)('ai'));
  return onSave;
}

const layoutTabProps = () =>
  (h.sidePanel?.layoutPanel as { props: { onChange: (d: LayoutDraft) => void; onSideBySideChange: (v: boolean) => void } } | null)
    ?.props;
const setDraft = (d: LayoutDraft) => act(() => layoutTabProps()!.onChange(d));
const typeContent = (value: string) => act(() => (h.props[0]!.onChange as (v: string) => void)(value));
const clickSave = () => fireEvent.click(screen.getByRole('button', { name: 'save' }));
const ctxOf = (onSave: ReturnType<typeof vi.fn>) => onSave.mock.calls[0][1] as PolicySaveContext;

// jsdom 未实现 <dialog>.showModal/close（丢弃确认用 ConfirmDialog）：补最小桩，只切换 open 属性。
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.open = false;
};

beforeEach(() => {
  h.props.length = 0;
  h.rail = undefined;
  h.sidePanel = undefined;
  h.display = undefined;
  Object.values(h.toast).forEach((fn) => fn.mockReset());
  window.localStorage.clear();
});

describe('保存三态（R13）', () => {
  it('untouched：保存上下文没有 layout 键', async () => {
    const onSave = renderForm({ initialLayout: VALID, hasActiveLayout: true });
    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect('layout' in ctxOf(onSave)).toBe(false);
    expect(ctxOf(onSave).locale).toBeTruthy();
  });

  it('edited：layout 深等该对象', async () => {
    const onSave = renderForm({});
    const layout = markStructural(identityLayout(LAYOUT_SOURCE), 6, 7, '');
    setDraft({ kind: 'edited', layout });
    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(ctxOf(onSave).layout).toEqual(layout);
  });

  it('removed：layout 为 null', async () => {
    const onSave = renderForm({ initialLayout: VALID, hasActiveLayout: true });
    setDraft({ kind: 'removed' });
    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(ctxOf(onSave).layout).toBeNull();
  });

  it('能力为假：不挂载排版标签（layoutPanel 为 null），保存上下文没有 layout 键', async () => {
    const onSave = renderForm({ structuredAuthoring: DENIED });
    expect(h.sidePanel?.layoutPanel).toBeNull();
    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect('layout' in ctxOf(onSave)).toBe(false);
  });

  it('草稿只存表单字段：localStorage 里没有 layout（schema 3 起含内嵌词汇字段，ADR 0060）', async () => {
    renderForm({});
    setDraft({ kind: 'edited', layout: identityLayout(`${LAYOUT_SOURCE}# x\n`) });
    typeContent(`${LAYOUT_SOURCE}# x\n`);
    await waitFor(
      () => {
        const raw = Object.keys(window.localStorage).map((k) => window.localStorage.getItem(k) ?? '');
        expect(raw.length).toBeGreaterThan(0);
        const draft = JSON.parse(raw[0]);
        expect(draft.v).toBe(3);
        expect(JSON.stringify(draft)).not.toContain('"layout"');
        expect(JSON.stringify(draft)).not.toContain('spans');
      },
      { timeout: 3000 },
    );
  });
});

describe('保存前的丢弃提示（Review Focus 4）', () => {
  it('无权用户、活跃版本有排版、改了 content → 确认框；取消不发请求，确认后保存并在丢弃时警告', async () => {
    const onSave = renderForm({
      structuredAuthoring: DENIED,
      hasActiveLayout: true,
      onSave: async () => ({ id: 'p1', layoutDropped: true }),
    });
    typeContent(`${LAYOUT_SOURCE}# changed\n`);
    clickSave();
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('layoutDrop.confirmTitle');
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onSave).not.toHaveBeenCalled();

    clickSave();
    fireEvent.click(await screen.findByRole('button', { name: 'layoutDrop.confirm' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect('layout' in ctxOf(onSave)).toBe(false);
    await waitFor(() => expect(h.toast.warning).toHaveBeenCalledWith('layoutDrop.dropped'));
  });

  it('无权用户只改名称（content 未变）→ 不弹确认框', async () => {
    const onSave = renderForm({ structuredAuthoring: DENIED, hasActiveLayout: true });
    act(() => (h.sidePanel!.onNameChange as (v: string) => void)('renamed'));
    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('有权用户、untouched、源码未改 → 不弹确认框', async () => {
    const onSave = renderForm({ initialLayout: VALID, hasActiveLayout: true });
    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('有权用户、untouched、源码改了而排版已对不上 → 确认框', async () => {
    const onSave = renderForm({ initialLayout: VALID, hasActiveLayout: true });
    typeContent(`${LAYOUT_SOURCE}# changed\n`);
    clickSave();
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('有权用户、已重新排版（edited）后改源码保存 → 不弹确认框', async () => {
    const source = `${LAYOUT_SOURCE}# changed\n`;
    const onSave = renderForm({ initialLayout: VALID, hasActiveLayout: true });
    typeContent(source);
    setDraft({ kind: 'edited', layout: identityLayout(source) });
    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('活跃版本没有排版的无权用户（今天的行为）：改源码保存不弹确认框，也没有警告', async () => {
    const onSave = renderForm({ structuredAuthoring: DENIED });
    typeContent(`${LAYOUT_SOURCE}# changed\n`);
    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(h.toast.warning).not.toHaveBeenCalled();
  });
});

describe('保存失败的 layout 错误码', () => {
  /** 与 useLayoutErrorText 相同的拼装：码文案 → 附上限 → 附行列。 */
  function expected(c: (typeof LAYOUT_ERROR_CASES)[number]): string {
    let message = `saveErrorCodes.${c.code}`;
    if (c.expect.limit) {
      const max = { sourceBytes: 12288, spans: 400 }[c.expect.limit as 'sourceBytes' | 'spans'];
      message = format('saveErrorCodes.withLimit', { message, limit: `layoutTab.limits.${c.expect.limit}`, max });
    }
    if (c.expect.offset !== undefined) {
      const { line, column } = positionAt(LAYOUT_SOURCE, c.expect.offset);
      message = format('saveErrorCodes.atPosition', { message, line, column });
    }
    return message;
  }

  it.each(LAYOUT_ERROR_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    for (const structuredAuthoring of [ALLOWED, DENIED]) {
      h.toast.error.mockReset();
      const onSave = renderForm({
        structuredAuthoring,
        onSave: async () => ({ message: 'server text', code: c.code, ...c.expect }),
      });
      clickSave();
      await waitFor(() => expect(onSave).toHaveBeenCalled());
      await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith('saveFailed', { description: expected(c) }));
      // 能力为真时打开「排版」标签；为假时没有该标签，不打开
      const tab = screen.getByTestId('side-panel').textContent;
      if (structuredAuthoring.allowed) expect(tab).toBe('layout');
      else expect(tab).not.toBe('layout');
      cleanup();
    }
  });
});

// 并排视图（T10）：Monaco 选区 → 高亮，诊断 → 标记，点击 display → 光标；都经 projectCanonicalRange / displayToCanonical
describe('并排视图', () => {
  function fakeEditor(text: string) {
    let listener: ((e: { selection: Record<string, number> }) => void) | null = null;
    return {
      ed: {
        onDidChangeCursorSelection: (fn: typeof listener) => {
          listener = fn;
          return { dispose: () => (listener = null) };
        },
        getModel: () => ({ getValue: () => text }),
        getSelection: () => null,
        setPosition: vi.fn(),
        revealLineInCenter: vi.fn(),
        focus: vi.fn(),
        hasTextFocus: () => false,
      },
      select: (s: Record<string, number>) => act(() => listener?.({ selection: s })),
    };
  }
  const LAYOUT = markStructural(identityLayout(LAYOUT_SOURCE), 18, 21, '\n');

  function openPane() {
    renderForm({ initialLayout: LAYOUT, hasActiveLayout: true });
    const { ed, select } = fakeEditor(LAYOUT_SOURCE);
    act(() => (h.props[0]!.onEditorReady as (e: unknown) => void)(ed));
    // 加载时带着一致的排版：并排视图缺省打开（修订 1 A2），不需要先点开关
    expect(screen.getByTestId('layout-display-pane')).toBeTruthy();
    return { ed, select };
  }

  it('第 2 行的诊断：markers[0].range 等于 projectCanonicalRange 的结果', () => {
    openPane();
    const diag = { severity: 'error', message: 'm', startLine: 3, startColumn: 6, endLine: 3, endColumn: 12 };
    act(() =>
      (h.props[0]!.onCompileChange as (s: unknown) => void)({ state: 'error', diagnostics: [diag], source: LAYOUT_SOURCE }),
    );
    const markers = h.display!.markers as Array<{ range: unknown; severity: string }>;
    expect(markers).toHaveLength(1);
    expect(markers[0]).toEqual({
      range: projectCanonicalRange(LAYOUT, offsetAt(LAYOUT_SOURCE, 3, 6), offsetAt(LAYOUT_SOURCE, 3, 12)),
      severity: 'error',
    });
  });

  it('诊断落后于当前源码时不投影', () => {
    openPane();
    act(() =>
      (h.props[0]!.onCompileChange as (s: unknown) => void)({
        state: 'error',
        diagnostics: [{ severity: 'error', message: 'm', startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 }],
        source: 'stale',
      }),
    );
    expect(h.display!.markers).toEqual([]);
  });

  it('Monaco 选区 → display 高亮', () => {
    const { select } = openPane();
    select({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 7 });
    expect(h.display!.highlight).toEqual(projectCanonicalRange(LAYOUT, 0, 6));
    // 选区落进结构 span：扩到整段 display
    select({ startLineNumber: 1, startColumn: 19, endLineNumber: 1, endColumn: 20 });
    expect(h.display!.highlight).toEqual(projectCanonicalRange(LAYOUT, 18, 19));
    // 没有选区的光标：高亮光标后的一个字符
    select({ startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 3 });
    expect(h.display!.highlight).toEqual(projectCanonicalRange(LAYOUT, 2, 3));
  });

  it('光标在代理对之前：高亮整个 emoji（不拆代理对）', () => {
    const source = 'Module a😀.\n';
    const layout = identityLayout(source);
    renderForm({ initialLayout: layout, hasActiveLayout: true, content: source });
    const { ed, select } = fakeEditor(source);
    act(() => (h.props[0]!.onEditorReady as (e: unknown) => void)(ed));
    act(() => layoutTabProps()!.onSideBySideChange(true));
    select({ startLineNumber: 1, startColumn: 9, endLineNumber: 1, endColumn: 9 });
    expect(h.display!.highlight).toEqual({ start: 8, end: 10 });
    // 光标落在代理对中间：退到码点起点，仍高亮整个 emoji
    select({ startLineNumber: 1, startColumn: 10, endLineNumber: 1, endColumn: 10 });
    expect(h.display!.highlight).toEqual({ start: 8, end: 10 });
  });

  it('点击 display 偏移：setPosition 的行列等于 positionAt(displayToCanonical(...).start)', () => {
    const { ed } = openPane();
    act(() => (h.display!.onDisplayOffsetClick as (n: number) => void)(25));
    const { line, column } = positionAt(LAYOUT_SOURCE, displayToCanonical(LAYOUT, 25).start);
    expect(ed.setPosition).toHaveBeenCalledWith({ lineNumber: line, column });
    expect(ed.revealLineInCenter).toHaveBeenCalledWith(line);
  });

  it('源码改了（排版失效）窗格收起；能力为假时从不渲染', () => {
    openPane();
    typeContent(`${LAYOUT_SOURCE}# x\n`);
    expect(screen.queryByTestId('layout-display-pane')).toBeNull();
    cleanup();
    renderForm({ structuredAuthoring: DENIED, initialLayout: LAYOUT, hasActiveLayout: true });
    expect(h.sidePanel?.layoutPanel).toBeNull();
    expect(screen.queryByTestId('layout-display-pane')).toBeNull();
  });
});

// 并排视图的默认状态与持久化（ADR 0058 修订 1 A2）：
// 加载时带着一致的排版且有能力 → 缺省打开；作者显式关闭按浏览器记住；没有排版或无能力时与改前一致（关闭）。
describe('并排视图默认打开与显式关闭的持久化（修订 1 A2）', () => {
  const KEY = 'aster.editor.layoutSideBySide';
  const LAYOUT = markStructural(identityLayout(LAYOUT_SOURCE), 18, 21, '\n');
  const pane = () => screen.queryByTestId('layout-display-pane');
  const toggleProps = () =>
    (h.sidePanel?.layoutPanel as { props: { sideBySide: boolean; onSideBySideChange: (v: boolean) => void } } | null)?.props;
  const remount = (opts: Parameters<typeof renderForm>[0]) => {
    cleanup();
    h.sidePanel = undefined;
    renderForm(opts);
  };

  it('有排版 + 有能力：首次打开编辑器即显示并排窗格，开关为按下状态，未写偏好', () => {
    renderForm({ initialLayout: LAYOUT, hasActiveLayout: true });
    expect(pane()).toBeTruthy();
    expect(toggleProps()!.sideBySide).toBe(true);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('显式关闭：本次收起并写入偏好；重新打开编辑器仍是关闭；显式再打开后恢复缺省打开', () => {
    renderForm({ initialLayout: LAYOUT, hasActiveLayout: true });
    act(() => toggleProps()!.onSideBySideChange(false));
    expect(pane()).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBe('false');

    remount({ initialLayout: LAYOUT, hasActiveLayout: true });
    expect(pane()).toBeNull();
    expect(toggleProps()!.sideBySide).toBe(false);

    act(() => toggleProps()!.onSideBySideChange(true));
    expect(pane()).toBeTruthy();
    expect(window.localStorage.getItem(KEY)).toBe('true');
    remount({ initialLayout: LAYOUT, hasActiveLayout: true });
    expect(pane()).toBeTruthy();
  });

  it('localStorage 不可用时缺省仍打开，显式关闭在本次会话内生效', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      renderForm({ initialLayout: LAYOUT, hasActiveLayout: true });
      expect(pane()).toBeTruthy();
      act(() => toggleProps()!.onSideBySideChange(false));
      expect(pane()).toBeNull();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
      // 偏好模块在存储不可用时把写入记在模块内（会话兜底）；恢复为缺省值，免得影响后续用例
      layoutSideBySidePreference.write(true);
    }
  });

  it.each([
    ['没有排版', { initialLayout: null, hasActiveLayout: false }],
    ['排版与源码不一致（编辑页未下发排版）', { initialLayout: null, hasActiveLayout: true }],
  ])('%s：与改前一致，不打开（偏好为 true 也一样）', (_name, opts) => {
    window.localStorage.setItem(KEY, 'true');
    renderForm(opts);
    expect(pane()).toBeNull();
    // 开始排版后开关仍是未按下（与改前一致），需作者自己打开
    act(() => layoutTabProps()!.onChange({ kind: 'edited', layout: identityLayout(LAYOUT_SOURCE) }));
    expect(toggleProps()!.sideBySide).toBe(false);
    expect(pane()).toBeNull();
  });

  it('无能力：即使下发了排版也没有窗格与排版入口', () => {
    renderForm({ structuredAuthoring: DENIED, initialLayout: LAYOUT, hasActiveLayout: true });
    expect(h.sidePanel?.layoutPanel).toBeNull();
    expect(pane()).toBeNull();
  });

  it('套用带排版的模板（#829 / #837）：作者之前关闭过也会打开，且不改写偏好', () => {
    window.localStorage.setItem(KEY, 'false');
    renderForm({ content: '' });
    expect(pane()).toBeNull();
    act(() => (h.sidePanel!.onApplyTemplate as (tpl: unknown) => void)(jingyesiShowcaseExample));
    expect(toggleProps()!.sideBySide).toBe(true);
    expect(pane()).toBeTruthy();
    expect(window.localStorage.getItem(KEY)).toBe('false');
  });
});
