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

function tabElement(
  editor: ReturnType<typeof fakeEditor> | null,
  terms: VocabularyTabTerm[],
  extra: { teamId?: string | null; policyLocale?: string } = {},
) {
  return (
    <IntlClientProvider locale="zh" messages={messages as never}>
      <VocabularyTab editor={editor as never} terms={terms} {...extra} />
    </IntlClientProvider>
  );
}

function renderTab(
  editor: ReturnType<typeof fakeEditor> | null,
  terms: VocabularyTabTerm[] = TERMS,
  extra: { teamId?: string | null; policyLocale?: string } = {},
) {
  return render(tabElement(editor, terms, extra));
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

describe('VocabularyTab 对话框稳定性与团队作用域', () => {
  it('对话框打开期间父级重渲染（词条轮询）不清空已输入内容', async () => {
    const editor = fakeEditor('Fahrer');
    const { rerender } = renderTab(editor);
    fireEvent.click(screen.getByRole('button', { name: M.addSelection }));
    const dialog = await screen.findByRole('dialog');
    const field = () =>
      within(dialog).getAllByRole('textbox').find((el) => (el as HTMLInputElement).value === 'Fahrer') as HTMLInputElement;
    await waitFor(() => expect(field()).toBeTruthy());
    fireEvent.change(field(), { target: { value: 'Fahrerin' } });
    rerender(tabElement(editor, [...TERMS]));
    rerender(tabElement(editor, [...TERMS, term('literal', 'no', 'nein')]));
    expect(within(dialog).getAllByRole('textbox').some((el) => (el as HTMLInputElement).value === 'Fahrerin')).toBe(true);
  });

  async function saveAndCaptureUrl(extra: { teamId?: string | null; policyLocale?: string }, terms = TERMS) {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    renderTab(fakeEditor('Fahrer'), terms, extra);
    fireEvent.click(screen.getByRole('button', { name: M.addSelection }));
    const dialog = await screen.findByRole('dialog');
    const textboxes = within(dialog).getAllByRole('textbox') as HTMLInputElement[];
    const byValue = (v: string) => textboxes.find((el) => el.value === v);
    await waitFor(() => expect(byValue('Fahrer')).toBeTruthy());
    return { fetchMock, dialog, textboxes };
  }

  it('预填策略语言；词条只有单一领域时预填领域', async () => {
    const { textboxes } = await saveAndCaptureUrl({ policyLocale: 'de-DE' });
    expect(textboxes.some((el) => el.value === 'de-DE')).toBe(true);
    expect(textboxes.some((el) => el.value === 'd')).toBe(true);
  });

  it('词条跨多个领域时领域留空', async () => {
    const mixed = [...TERMS, { ...term('struct', 'Car', 'Auto'), domain: 'other' }];
    const { textboxes } = await saveAndCaptureUrl({ policyLocale: 'de-DE' }, mixed);
    expect(textboxes.some((el) => el.value === 'd' || el.value === 'other')).toBe(false);
  });

  it('团队策略的 POST 带 ?teamId=；个人策略不带', async () => {
    const team = await saveAndCaptureUrl({ teamId: 'team 1', policyLocale: 'de-DE' });
    // 预填后仍缺 canonical 等必填项，补齐后提交
    const inputs = team.dialog.querySelectorAll('input');
    for (const el of Array.from(inputs)) {
      if (!(el as HTMLInputElement).value) fireEvent.change(el, { target: { value: 'Fahrer' } });
    }
    team.dialog.querySelector('form')?.requestSubmit();
    await waitFor(() => expect(team.fetchMock).toHaveBeenCalled());
    const calls = team.fetchMock.mock.calls as unknown as Array<[string]>;
    expect(calls[0][0]).toBe('/api/v1/domain-vocabularies/terms?teamId=team%201');
  });

  it('个人策略的 POST 不带 teamId', async () => {
    const personal = await saveAndCaptureUrl({ teamId: null, policyLocale: 'de-DE' });
    for (const el of Array.from(personal.dialog.querySelectorAll('input'))) {
      if (!(el as HTMLInputElement).value) fireEvent.change(el, { target: { value: 'Fahrer' } });
    }
    personal.dialog.querySelector('form')?.requestSubmit();
    await waitFor(() => expect(personal.fetchMock).toHaveBeenCalled());
    const calls = personal.fetchMock.mock.calls as unknown as Array<[string]>;
    expect(calls[0][0]).toBe('/api/v1/domain-vocabularies/terms');
  });
});

describe('VocabularyTab 空状态与链接', () => {
  it('无词条时显示空状态，含管理页链接', () => {
    renderTab(fakeEditor(), []);
    expect(screen.getByText(M.empty)).toBeTruthy();
    expect(screen.getByRole('link', { name: M.manage }).getAttribute('href')).toBe('/zh/domain-vocabularies');
  });

  it('有词条时页脚同样有管理页链接，新标签页打开以保留未保存编辑', () => {
    renderTab(fakeEditor());
    const link = screen.getByRole('link', { name: M.manage });
    expect(link.getAttribute('href')).toBe('/zh/domain-vocabularies');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
