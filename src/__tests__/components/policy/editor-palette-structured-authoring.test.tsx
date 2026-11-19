// 命令面板的结构化编写项（ADR 0058 §8.3）：只在能力为真时出现；「切换词汇规范预览」另需 LSP 支持。
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import zhBase from '@aster-cloud/ui-messages/zh-CN.json';

// 全局 setup 把 lucide-react 替换成了部分桩，面板用到的图标须取真实模块
vi.mock('lucide-react', async () => ({ ...(await vi.importActual<Record<string, unknown>>('lucide-react')) }));

import { IntlClientProvider } from '@/i18n/intl-client-provider';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';
import { EditorPalette, type StructuredAuthoringPaletteActions } from '@/components/policy/policy-form/editor-palette';

const messages = deepMergeMessages(zhBase as Record<string, unknown>, DEMO_SUPPLEMENT.zh) as {
  policyEditor: { palette: Record<string, string> };
};
const P = messages.policyEditor.palette;
const SA_LABELS = [P.newStruct, P.openModelTab, P.openVocabularyTab, P.toggleCanonicalPreview];

beforeAll(() => {
  // jsdom 未实现 <dialog> 的模态 API
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
  };
});
afterEach(cleanup);

function palette(structuredAuthoring?: StructuredAuthoringPaletteActions | null, onClose = vi.fn()) {
  const noop = () => {};
  return (
    <IntlClientProvider locale="zh" messages={messages as never}>
      <EditorPalette
        isOpen
        onClose={onClose}
        uiLocale="zh"
        onAskAI={noop}
        onInsertTemplate={noop}
        onConvertLocale={noop}
        onFormat={noop}
        onSave={noop}
        onSaveAndView={noop}
        onTogglePanel={noop}
        onShowSyntax={noop}
        onShowDecision={noop}
        structuredAuthoring={structuredAuthoring}
      />
    </IntlClientProvider>
  );
}

const actions = (withPreview = true) => ({
  onOpenModelTab: vi.fn(),
  onOpenVocabularyTab: vi.fn(),
  onNewStruct: vi.fn(),
  onToggleCanonicalPreview: withPreview ? vi.fn() : null,
});

const rowLabels = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('li button')).map((b) => b.textContent?.trim() ?? '');

describe('EditorPalette 结构化编写项', () => {
  it('能力为假（未传 actions）：面板 DOM 与未接入时一致，不含任何结构化编写项', () => {
    const { container: baseline } = render(palette(undefined));
    const before = baseline.innerHTML;
    cleanup();
    const { container } = render(palette(null));
    expect(container.innerHTML).toBe(before);
    for (const label of SA_LABELS) expect(screen.queryByText(label)).toBeNull();
  });

  it('能力为真：出现四项，原有项不变且排在前面', () => {
    const { container: baseline } = render(palette(null));
    const baseLabels = rowLabels(baseline);
    cleanup();
    const { container } = render(palette(actions()));
    const labels = rowLabels(container);
    for (const label of SA_LABELS) expect(labels).toContain(label);
    expect(labels.filter((l) => !SA_LABELS.includes(l))).toEqual(baseLabels);
  });

  it('LSP 不支持预览：不出现「切换词汇规范预览」', () => {
    render(palette(actions(false)));
    expect(screen.getByText(P.openModelTab)).toBeTruthy();
    expect(screen.queryByText(P.toggleCanonicalPreview)).toBeNull();
  });

  it('点击各项调用对应动作并关闭面板', () => {
    const a = actions();
    const onClose = vi.fn();
    render(palette(a, onClose));
    fireEvent.click(screen.getByText(P.openModelTab));
    fireEvent.click(screen.getByText(P.openVocabularyTab));
    fireEvent.click(screen.getByText(P.newStruct));
    fireEvent.click(screen.getByText(P.toggleCanonicalPreview));
    expect(a.onOpenModelTab).toHaveBeenCalledTimes(1);
    expect(a.onOpenVocabularyTab).toHaveBeenCalledTimes(1);
    expect(a.onNewStruct).toHaveBeenCalledTimes(1);
    expect(a.onToggleCanonicalPreview).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(4);
  });

  it('搜索能过滤到结构化编写项', () => {
    render(palette(actions()));
    fireEvent.change(screen.getByRole('textbox', { hidden: true }), { target: { value: P.newStruct } });
    expect(screen.getByText(P.newStruct)).toBeTruthy();
    expect(screen.queryByText(P.openVocabularyTab)).toBeNull();
  });
});
