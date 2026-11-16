// 词汇标签页（ADR 0058 §8.3）：按角色分组、搜索、点击插入、把选中文字加为术语。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import zhBase from '@aster-cloud/ui-messages/zh-CN.json';
import { IntlClientProvider } from '@/i18n/intl-client-provider';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';
import { VocabularyTab } from '@/components/policy/policy-form/vocabulary-tab';
import type { VocabularyTabTerm } from '@/hooks/useUserVocabularyRegistration';

const messages = deepMergeMessages(zhBase as Record<string, unknown>, DEMO_SUPPLEMENT.zh) as {
  policyEditor: { vocabularyTab: Record<string, string> };
};
const M = messages.policyEditor.vocabularyTab;

const term = (kind: VocabularyTabTerm['kind'], canonical: string, localized: string, parent?: string): VocabularyTabTerm => ({
  kind,
  canonical,
  localized,
  ...(parent ? { parent } : {}),
  domain: 'd',
  locale: 'de',
});

const TERMS: VocabularyTabTerm[] = [
  term('struct', 'Driver', 'Fahrer'),
  term('field', 'age', 'alter', 'Driver'),
  term('field', 'name', 'name', 'Driver'),
  term('field', 'amount', 'betrag', 'Loan'),
  term('function', 'score', 'bewerte'),
  term('enum_value', 'Gold', 'Gold', 'Tier'),
  term('literal', 'yes', 'ja'),
];

function fakeEditor(selected = '') {
  const range = { startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 3 + selected.length };
  let listener: (() => void) | null = null;
  const state = { selected };
  return {
    state,
    getSelection: () => range,
    getModel: () => ({ getValueInRange: () => state.selected }),
    onDidChangeCursorSelection: vi.fn((cb: () => void) => {
      listener = cb;
      return { dispose: vi.fn() };
    }),
    fire: () => listener?.(),
    executeEdits: vi.fn(() => true),
    pushUndoStop: vi.fn(),
    focus: vi.fn(),
  };
}

function renderTab(editor: ReturnType<typeof fakeEditor> | null, terms: VocabularyTabTerm[] = TERMS) {
  return render(
    <IntlClientProvider locale="zh" messages={messages as never}>
      <VocabularyTab editor={editor as never} terms={terms} />
    </IntlClientProvider>,
  );
}

afterEach(cleanup);

describe('VocabularyTab 分组', () => {
  it('五组各带计数，字段再按 parent 分组', () => {
    renderTab(fakeEditor());
    for (const key of ['groupStruct', 'groupField', 'groupFunction', 'groupEnumValue', 'groupLiteral']) {
      expect(screen.getByTestId(`vocab-group-${key}`)).toBeTruthy();
    }
    const fields = screen.getByTestId('vocab-group-groupField');
    expect(within(fields).getByText(/^3$/)).toBeTruthy();
    expect(within(fields).getByText('Driver')).toBeTruthy();
    expect(within(fields).getByText('Loan')).toBeTruthy();
    expect(within(screen.getByTestId('vocab-group-groupStruct')).getByText(/^1$/)).toBeTruthy();
  });

  it('搜索 canonical 命中本地化行；无匹配显示无结果', () => {
    renderTab(fakeEditor());
    const input = screen.getByRole('searchbox');
    fireEvent.change(input, { target: { value: 'Driver' } });
    expect(screen.getByRole('button', { name: /Fahrer/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /bewerte/ })).toBeNull();
    fireEvent.change(input, { target: { value: 'zzzz' } });
    expect(screen.getByText(M.noMatch)).toBeTruthy();
  });
});

describe('VocabularyTab 插入', () => {
  it('点击术语：executeEdits 在选区位置插入 localized', () => {
    const editor = fakeEditor();
    renderTab(editor);
    fireEvent.click(screen.getByRole('button', { name: /bewerte/ }));
    expect(editor.executeEdits).toHaveBeenCalledTimes(1);
    const [, edits] = editor.executeEdits.mock.calls[0] as unknown as [string, Array<{ text: string; range: unknown }>];
    expect(edits[0].text).toBe('bewerte');
    expect(edits[0].range).toEqual({ startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 3 });
    expect(editor.pushUndoStop).toHaveBeenCalled();
    expect(editor.focus).toHaveBeenCalled();
  });
});

describe('VocabularyTab 加为术语', () => {
  it('无选区时按钮禁用', () => {
    renderTab(fakeEditor(''));
    expect((screen.getByRole('button', { name: M.addSelection }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('有选区时启用，点击打开词汇对话框并预填选中文字', async () => {
    const editor = fakeEditor('Fahrer');
    renderTab(editor);
    const button = screen.getByRole('button', { name: M.addSelection }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(within(dialog).getAllByRole('textbox').some((el) => (el as HTMLInputElement).value === 'Fahrer')).toBe(true);
    });
  });

  it('选区变化事件刷新按钮状态', () => {
    const editor = fakeEditor('');
    renderTab(editor);
    editor.state.selected = 'x';
    editor.fire();
    return waitFor(() =>
      expect((screen.getByRole('button', { name: M.addSelection }) as HTMLButtonElement).disabled).toBe(false),
    );
  });
});

describe('VocabularyTab 空状态与链接', () => {
  it('无词条时显示空状态，含管理页链接', () => {
    renderTab(fakeEditor(), []);
    expect(screen.getByText(M.empty)).toBeTruthy();
    expect(screen.getByRole('link', { name: M.manage }).getAttribute('href')).toBe('/zh/domain-vocabularies');
  });

  it('有词条时页脚同样有管理页链接', () => {
    renderTab(fakeEditor());
    expect(screen.getByRole('link', { name: M.manage }).getAttribute('href')).toBe('/zh/domain-vocabularies');
  });
});
