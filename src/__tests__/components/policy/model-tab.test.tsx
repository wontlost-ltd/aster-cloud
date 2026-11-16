// 模型标签页（ADR 0058 §8.3）：大纲点击跳到定义；表单生成本地化源码经 executeEdits 插入编辑器。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import zhBase from '@aster-cloud/ui-messages/zh-CN.json';
import { EN_US, ZH_CN, type Lexicon } from '@aster-cloud/aster-lang-ts/browser';
import { IntlClientProvider } from '@/i18n/intl-client-provider';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';
import { ModelTab } from '@/components/policy/policy-form/model-tab';
import { buildStructSource } from '@/lib/structured-authoring/source-builders';

const messages = deepMergeMessages(zhBase as Record<string, unknown>, DEMO_SUPPLEMENT.zh) as {
  policyEditor: { modelTab: Record<string, string> };
};
const M = messages.policyEditor.modelTab;
const ADD_FIELD_PERSON = M.addFieldTo.replace('{name}', 'Person');

const SOURCE = [
  'Module demo.',
  '',
  'Use lib as L.',
  '',
  'Define Person with',
  '  name as Text and',
  '  age as Int.',
  '',
  'Type Score as Int.',
].join('\n');

/** 只实现模型标签页用到的 Monaco 编辑器方法。 */
function fakeEditor(text: string) {
  const lines = text.split('\n');
  return {
    getModel: () => ({
      getValue: () => text,
      getLineCount: () => lines.length,
      getLineMaxColumn: (line: number) => lines[line - 1].length + 1,
    }),
    revealLineInCenter: vi.fn(),
    setPosition: vi.fn(),
    focus: vi.fn(),
    executeEdits: vi.fn(() => true),
    pushUndoStop: vi.fn(),
  };
}

function renderTab(editor: ReturnType<typeof fakeEditor> | null, source: string, lexicon: Lexicon = EN_US) {
  return render(
    <IntlClientProvider locale="zh" messages={messages as never}>
      <ModelTab editor={editor as never} source={source} lexicon={lexicon} />
    </IntlClientProvider>,
  );
}

afterEach(cleanup);

describe('ModelTab 大纲', () => {
  it('列出结构体、字段、类型别名与导入别名', () => {
    renderTab(fakeEditor(SOURCE), SOURCE);
    expect(screen.getByRole('button', { name: /^Person$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^age/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Score/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^L/ })).toBeTruthy();
  });

  it('点击大纲项：revealLineInCenter + setPosition 到 span.start', () => {
    const editor = fakeEditor(SOURCE);
    renderTab(editor, SOURCE);
    fireEvent.click(screen.getByRole('button', { name: /^age/ }));
    expect(editor.revealLineInCenter).toHaveBeenCalledWith(7);
    expect(editor.setPosition).toHaveBeenCalledWith({ lineNumber: 7, column: 3 });

    fireEvent.click(screen.getByRole('button', { name: /^Score/ }));
    expect(editor.revealLineInCenter).toHaveBeenLastCalledWith(9);
    expect(editor.setPosition).toHaveBeenLastCalledWith({ lineNumber: 9, column: 1 });
  });

  it('语法错误时显示「修复语法后显示大纲」', () => {
    const bad = 'Module demo.\n\nDefine Person with name: Text.\n';
    renderTab(fakeEditor(bad), bad);
    expect(screen.getByText(M.outlineUnavailable)).toBeTruthy();
  });
});

describe('ModelTab 表单', () => {
  it('新建结构体：在文档末尾插入 buildStructSource 的输出', () => {
    const editor = fakeEditor(SOURCE);
    renderTab(editor, SOURCE);
    fireEvent.click(screen.getByRole('button', { name: M.newStruct }));
    const form = screen.getByRole('form', { name: M.newStruct });
    fireEvent.change(within(form).getByLabelText(M.structName), { target: { value: 'Applicant' } });
    fireEvent.change(within(form).getAllByLabelText(M.fieldName)[0], { target: { value: 'income' } });
    fireEvent.change(within(form).getAllByLabelText(M.fieldType)[0], { target: { value: 'Float' } });
    fireEvent.click(within(form).getByRole('button', { name: M.addFieldRow }));
    fireEvent.change(within(form).getAllByLabelText(M.fieldName)[1], { target: { value: 'owner' } });
    fireEvent.change(within(form).getAllByLabelText(M.fieldType)[1], { target: { value: 'Person' } });
    fireEvent.click(within(form).getByRole('button', { name: M.insert }));

    const expected = buildStructSource(EN_US, {
      name: 'Applicant',
      fields: [
        { name: 'income', type: 'Float' },
        { name: 'owner', type: 'Person' },
      ],
    });
    expect(editor.executeEdits).toHaveBeenCalledTimes(1);
    const [, edits] = editor.executeEdits.mock.calls[0] as unknown as [string, Array<{ range: unknown; text: string }>];
    expect(edits[0].range).toEqual({ startLineNumber: 9, startColumn: 19, endLineNumber: 9, endColumn: 19 });
    expect(edits[0].text).toBe(`\n\n${expected}\n`);
  });

  it('类型下拉含本地化内置类型、结构体与类型别名', () => {
    renderTab(fakeEditor(SOURCE), SOURCE);
    fireEvent.click(screen.getByRole('button', { name: M.newStruct }));
    const select = screen.getAllByLabelText(M.fieldType)[0] as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['Text', 'Int', 'Float', 'Bool', 'Person', 'Score']);
  });

  it('添加字段：插在该结构体最后一个字段之后', () => {
    const editor = fakeEditor(SOURCE);
    renderTab(editor, SOURCE);
    fireEvent.click(screen.getByRole('button', { name: ADD_FIELD_PERSON }));
    const form = screen.getByRole('form', { name: ADD_FIELD_PERSON });
    fireEvent.change(within(form).getByLabelText(M.fieldName), { target: { value: 'score' } });
    fireEvent.change(within(form).getByLabelText(M.fieldType), { target: { value: 'Score' } });
    fireEvent.click(within(form).getByRole('button', { name: M.insert }));

    const [, edits] = editor.executeEdits.mock.calls[0] as unknown as [string, Array<{ range: unknown; text: string }>];
    // 最后一个字段 `age as Int` 结束于第 7 行第 13 列（不含句点）
    expect(edits[0].range).toEqual({ startLineNumber: 7, startColumn: 13, endLineNumber: 7, endColumn: 13 });
    expect(edits[0].text).toBe(' and score as Score');
  });

  it('编辑器内容已变（大纲未刷新）时不按旧位置插入字段', () => {
    const editor = fakeEditor(`${SOURCE}\n-- 新输入`);
    renderTab(editor, SOURCE);
    fireEvent.click(screen.getByRole('button', { name: ADD_FIELD_PERSON }));
    const form = screen.getByRole('form', { name: ADD_FIELD_PERSON });
    fireEvent.change(within(form).getByLabelText(M.fieldName), { target: { value: 'score' } });
    fireEvent.click(within(form).getByRole('button', { name: M.insert }));
    expect(editor.executeEdits).not.toHaveBeenCalled();
    expect(screen.getByText(M.outlineStale)).toBeTruthy();
  });

  it('新建类型别名（zh-CN）：插入本地化源码', () => {
    const zh = '模块 demo。\n\n定义 人员 包含 姓名 作为 文本。\n';
    const editor = fakeEditor(zh);
    renderTab(editor, zh, ZH_CN);
    fireEvent.click(screen.getByRole('button', { name: M.newTypeAlias }));
    const form = screen.getByRole('form', { name: M.newTypeAlias });
    fireEvent.change(within(form).getByLabelText(M.aliasName), { target: { value: '客户' } });
    fireEvent.change(within(form).getByLabelText(M.aliasTarget), { target: { value: '人员' } });
    fireEvent.click(within(form).getByRole('button', { name: M.insert }));

    const [, edits] = editor.executeEdits.mock.calls[0] as unknown as [string, Array<{ range: unknown; text: string }>];
    // 文档以单个换行结尾：补一个换行隔出空行
    expect(edits[0].range).toEqual({ startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: 1 });
    expect(edits[0].text).toBe('\nType 客户 作为 人员。\n');
  });

  it('名字为空时插入按钮不可用', () => {
    renderTab(fakeEditor(SOURCE), SOURCE);
    fireEvent.click(screen.getByRole('button', { name: M.newTypeAlias }));
    const form = screen.getByRole('form', { name: M.newTypeAlias });
    expect((within(form).getByRole('button', { name: M.insert }) as HTMLButtonElement).disabled).toBe(true);
  });
});
