// 编辑器「排版」标签页（ADR 0058 §7.4–7.6，计划 T10，裁决 R12）：入口、上限、切分、导入、失效与实时校验。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import enBase from '@aster-cloud/ui-messages/en-US.json';
import { toCanonical, type PolicyLayout } from '@aster-cloud/aster-lang-ts/layout';
import { IntlClientProvider } from '@/i18n/intl-client-provider';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';
import { LayoutTab, type LayoutDraft, type LayoutTabProps } from '@/components/policy/policy-form/layout-tab';
import { identityLayout, markStructural } from '@/lib/policy-layout/edit-ops';
import { LAYOUT_ERROR_CASES, LAYOUT_SOURCE, LAYOUT_VALID_CASE } from '../../fixtures/layout-error-cases';

const messages = deepMergeMessages(enBase as Record<string, unknown>, DEMO_SUPPLEMENT.en);
const L = (messages as { policyEditor: { layoutTab: Record<string, never>; saveErrorCodes: Record<string, string> } }).policyEditor;
const TAB = L.layoutTab as unknown as Record<string, string> & {
  opErrors: Record<string, string>;
  limits: Record<string, string>;
};
const CODES = L.saveErrorCodes;

type Selection = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };

function fakeEditor(selection: Selection | null = null) {
  return {
    getSelection: () => selection,
    revealLineInCenter: vi.fn(),
    setPosition: vi.fn(),
    focus: vi.fn(),
  };
}

function renderTab(props: Partial<LayoutTabProps> & { editor?: ReturnType<typeof fakeEditor> } = {}) {
  const onChange = vi.fn<(next: LayoutDraft) => void>();
  const onSideBySideChange = vi.fn();
  const all: LayoutTabProps = {
    editor: null,
    source: LAYOUT_SOURCE,
    cnlLocale: 'en-US',
    aliasSet: null,
    layout: null,
    inconsistent: false,
    sideBySide: false,
    onSideBySideChange,
    onChange,
    ...props,
  } as LayoutTabProps;
  const utils = render(
    <IntlClientProvider locale="en" messages={messages as never}>
      <LayoutTab {...all} />
    </IntlClientProvider>,
  );
  return { ...utils, onChange, onSideBySideChange };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('LayoutTab 入口与上限', () => {
  it('13 000 字节源码：不显示「开始排版」，显示上限文案与上限值', () => {
    const source = `Module big.\n${'#'.repeat(13000)}\n`;
    renderTab({ source });
    expect(screen.queryByRole('button', { name: TAB.start })).toBeNull();
    expect(screen.queryByRole('button', { name: TAB.importJson })).toBeNull();
    const notice = document.querySelector('[data-layout-limit="sourceBytes"]');
    expect(notice?.textContent).toContain(TAB.limits.sourceBytes);
    expect(notice?.textContent).toContain('12288');
  });

  it('「开始排版」回调恒等排版', () => {
    const { onChange } = renderTab();
    fireEvent.click(screen.getByRole('button', { name: TAB.start }));
    expect(onChange).toHaveBeenCalledWith({ kind: 'edited', layout: identityLayout(LAYOUT_SOURCE) });
  });

  it('已存排版不一致：提示未加载，仍可开始新排版', () => {
    renderTab({ inconsistent: true });
    expect(document.querySelector('[data-layout-stored-inconsistent]')?.textContent).toBe(TAB.storedInconsistent);
    expect(screen.getByRole('button', { name: TAB.start })).toBeTruthy();
  });
});

describe('LayoutTab 导入 JSON', () => {
  it('非法 JSON 显示 layout_invalid_format 的文案，不回调', () => {
    const { onChange } = renderTab();
    fireEvent.click(screen.getByRole('button', { name: TAB.importJson }));
    fireEvent.change(screen.getByLabelText(TAB.importLabel), { target: { value: '{"v":1,' } });
    fireEvent.click(screen.getByRole('button', { name: TAB.importApply }));
    expect(screen.getByRole('alert').textContent).toBe(CODES.layout_invalid_format);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('合法 JSON 回调该排版', () => {
    const { onChange } = renderTab();
    fireEvent.click(screen.getByRole('button', { name: TAB.importJson }));
    fireEvent.change(screen.getByLabelText(TAB.importLabel), { target: { value: JSON.stringify(LAYOUT_VALID_CASE.layout) } });
    fireEvent.click(screen.getByRole('button', { name: TAB.importApply }));
    expect(onChange).toHaveBeenCalledWith({ kind: 'edited', layout: LAYOUT_VALID_CASE.layout });
  });
});

describe('LayoutTab 切分', () => {
  // 第 1 行「Module demo.layout.」：选中第 7 列的空格（偏移 6）
  const SPACE: Selection = { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 8 };

  it('选区标为结构：按 offsetAt 换算后 markStructural，display 先与 canonical 相同', () => {
    const layout = identityLayout(LAYOUT_SOURCE);
    const { onChange } = renderTab({ layout, editor: fakeEditor(SPACE) as never });
    fireEvent.click(screen.getByRole('button', { name: TAB.markSelection }));
    expect(onChange).toHaveBeenCalledWith({ kind: 'edited', layout: markStructural(layout, 6, 7, ' ') });
  });

  it('选区跨结构 span：显示 crosses_structural 文案且不回调', () => {
    const layout = markStructural(identityLayout(LAYOUT_SOURCE), 6, 7, '');
    const { onChange } = renderTab({
      layout,
      editor: fakeEditor({ startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 10 }) as never,
    });
    fireEvent.click(screen.getByRole('button', { name: TAB.markSelection }));
    expect(screen.getByText(TAB.opErrors.crosses_structural)).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('空选区：显示 empty_range 文案', () => {
    renderTab({
      layout: identityLayout(LAYOUT_SOURCE),
      editor: fakeEditor({ startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 3 }) as never,
    });
    fireEvent.click(screen.getByRole('button', { name: TAB.markSelection }));
    expect(screen.getByText(TAB.opErrors.empty_range)).toBeTruthy();
  });

  it('结构片段列表：改 display、恢复为内容', () => {
    const layout = markStructural(identityLayout(LAYOUT_SOURCE), 6, 7, ' ');
    const { onChange } = renderTab({ layout });
    const input = screen.getByLabelText(TAB.displayInputLabel.replace('{canonical}', ' '));
    fireEvent.change(input, { target: { value: '' } });
    const edited = onChange.mock.calls[0][0] as Extract<LayoutDraft, { kind: 'edited' }>;
    expect(edited.layout.spans[1]).toEqual({ canonical: ' ', display: '' });
    expect(toCanonical(edited.layout)).toBe(LAYOUT_SOURCE);
    fireEvent.click(screen.getByRole('button', { name: TAB.unmark }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'edited', layout: identityLayout(LAYOUT_SOURCE) });
  });

  it('并排视图开关', () => {
    const { onSideBySideChange } = renderTab({ layout: identityLayout(LAYOUT_SOURCE) });
    const toggle = screen.getByRole('button', { name: TAB.sideBySide });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(onSideBySideChange).toHaveBeenCalledWith(true);
  });
});

describe('LayoutTab 失效（R12）', () => {
  it('源码改后显示「排版已失效」与两个出口', () => {
    const { onChange } = renderTab({ layout: identityLayout(LAYOUT_SOURCE), source: `${LAYOUT_SOURCE}# more\n` });
    expect(document.querySelector('[data-layout-invalidated]')?.textContent).toBe(TAB.invalidated);
    expect(screen.queryByRole('button', { name: TAB.markSelection })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: TAB.restart }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'edited', layout: identityLayout(`${LAYOUT_SOURCE}# more\n`) });
    fireEvent.click(screen.getByRole('button', { name: TAB.remove }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'removed' });
  });
});

describe('LayoutTab 实时校验（与保存同一实现）', () => {
  it('合法排版显示「排版有效」', async () => {
    renderTab({ layout: LAYOUT_VALID_CASE.layout as PolicyLayout });
    expect(screen.getByRole('status').textContent).toBe(TAB.checking);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(TAB.valid));
  });

  it('防抖：300 ms 之前不校验', () => {
    vi.useFakeTimers();
    renderTab({ layout: LAYOUT_VALID_CASE.layout as PolicyLayout });
    act(() => vi.advanceTimersByTime(299));
    expect(screen.getByRole('status').textContent).toBe(TAB.checking);
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('status').textContent).toBe(TAB.valid);
  });

  // 往返不符的排版在标签页里先表现为「已失效」（R12）；源码超上限时入口本身被收起——两种情况都不进入实时校验
  it.each(LAYOUT_ERROR_CASES.filter((c) => c.status === 400).map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const editor = fakeEditor();
    renderTab({ layout: c.input.layout as PolicyLayout, source: c.input.source, aliasSet: c.input.aliasSet ?? null, editor: editor as never });
    if (c.code === 'layout_roundtrip_mismatch') {
      expect(document.querySelector('[data-layout-invalidated]')).toBeTruthy();
      return;
    }
    if (c.expect.limit === 'sourceBytes') {
      expect(document.querySelector('[data-layout-limit="sourceBytes"]')?.textContent).toContain(TAB.limits.sourceBytes);
      return;
    }
    const alert = await waitFor(() => {
      const el = document.querySelector(`[data-layout-validation="${c.code}"]`);
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(alert.textContent).toContain(CODES[c.code]);
    if (c.expect.limit) expect(alert.textContent).toContain(TAB.limits[c.expect.limit]);
    if (c.expect.offset !== undefined) {
      // 偏移换算成行列，点击跳转到编辑器
      fireEvent.click(screen.getByRole('button', { name: /^Go to line \d+$/ }));
      expect(editor.setPosition).toHaveBeenCalledTimes(1);
      expect(editor.revealLineInCenter).toHaveBeenCalledTimes(1);
    }
  });
});

describe('四种语言的排版文案', () => {
  it.each(['en', 'zh', 'de', 'hi'] as const)('%s：标签页、错误码与丢弃提示非空', (locale) => {
    const editor = (DEMO_SUPPLEMENT[locale] as { policyEditor: Record<string, Record<string, unknown>> }).policyEditor;
    const flat = (o: unknown): string[] =>
      typeof o === 'string' ? [o] : Object.values(o as Record<string, unknown>).flatMap(flat);
    for (const key of ['layoutTab', 'saveErrorCodes', 'layoutDrop']) {
      const values = flat(editor[key]);
      expect(values.length).toBeGreaterThan(0);
      for (const v of values) expect(v.trim()).not.toBe('');
    }
    const en = (DEMO_SUPPLEMENT.en as { policyEditor: Record<string, unknown> }).policyEditor;
    const keys = (o: unknown, p = ''): string[] =>
      typeof o === 'string' ? [p] : Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => keys(v, `${p}.${k}`));
    for (const key of ['layoutTab', 'saveErrorCodes', 'layoutDrop']) {
      expect(keys(editor[key]).sort()).toEqual(keys(en[key]).sort());
    }
  });
});
