// 模型标签页（ADR 0058 §8.3）：大纲点击跳到定义；表单生成本地化源码经 executeEdits 插入编辑器。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import zhBase from '@aster-cloud/ui-messages/zh-CN.json';
import { DE_DE, EN_US, HI_IN, ZH_CN, type Lexicon } from '@aster-cloud/aster-lang-ts/browser';
vi.mock('@/lib/structured-authoring/outline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/structured-authoring/outline')>();
  return { ...actual, buildModelOutline: vi.fn(actual.buildModelOutline) };
});

import { buildModelOutline } from '@/lib/structured-authoring/outline';
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

  it('大纲随源码刷新后，过期提示消失', () => {
    const editor = fakeEditor(`${SOURCE}\n-- 新输入`);
    const tree = (source: string) => (
      <IntlClientProvider locale="zh" messages={messages as never}>
        <ModelTab editor={editor as never} source={source} lexicon={EN_US} />
      </IntlClientProvider>
    );
    const { rerender } = render(tree(SOURCE));
    fireEvent.click(screen.getByRole('button', { name: ADD_FIELD_PERSON }));
    const form = screen.getByRole('form', { name: ADD_FIELD_PERSON });
    fireEvent.change(within(form).getByLabelText(M.fieldName), { target: { value: 'score' } });
    fireEvent.click(within(form).getByRole('button', { name: M.insert }));
    expect(screen.getByText(M.outlineStale)).toBeTruthy();
    rerender(tree(`${SOURCE}\n-- 新输入`));
    expect(screen.queryByText(M.outlineStale)).toBeNull();
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
    // 类型别名引导词取 lexicon 的 TYPE_ALIAS（ADR 0058 修订 2）
    expect(edits[0].text).toBe('\n类型 客户 作为 人员。\n');
  });

  it('名字为空时插入按钮不可用', () => {
    renderTab(fakeEditor(SOURCE), SOURCE);
    fireEvent.click(screen.getByRole('button', { name: M.newTypeAlias }));
    const form = screen.getByRole('form', { name: M.newTypeAlias });
    expect((within(form).getByRole('button', { name: M.insert }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('ModelTab 名字校验', () => {
  const openStruct = () => {
    fireEvent.click(screen.getByRole('button', { name: M.newStruct }));
    return screen.getByRole('form', { name: M.newStruct });
  };
  const insertButton = (form: HTMLElement) => within(form).getByRole('button', { name: M.insert }) as HTMLButtonElement;

  it('结构体名含空格：禁用插入并显示行内错误', () => {
    renderTab(fakeEditor(SOURCE), SOURCE);
    const form = openStruct();
    fireEvent.change(within(form).getByLabelText(M.structName), { target: { value: 'my struct' } });
    fireEvent.change(within(form).getAllByLabelText(M.fieldName)[0], { target: { value: 'x' } });
    expect(insertButton(form).disabled).toBe(true);
    expect(within(form).getByRole('alert').textContent).toBe(M.invalidName);
  });

  it('结构体名含标点（注入第二条声明）被拒', () => {
    renderTab(fakeEditor(SOURCE), SOURCE);
    const form = openStruct();
    fireEvent.change(within(form).getByLabelText(M.structName), { target: { value: 'A. Rule r' } });
    fireEvent.change(within(form).getAllByLabelText(M.fieldName)[0], { target: { value: 'x' } });
    expect(insertButton(form).disabled).toBe(true);
  });

  it('字段名无效或与另一行重名：禁用插入', () => {
    renderTab(fakeEditor(SOURCE), SOURCE);
    const form = openStruct();
    fireEvent.change(within(form).getByLabelText(M.structName), { target: { value: 'Applicant' } });
    fireEvent.change(within(form).getAllByLabelText(M.fieldName)[0], { target: { value: 'a b' } });
    expect(insertButton(form).disabled).toBe(true);
    expect(within(form).getByRole('alert').textContent).toBe(M.invalidName);
    fireEvent.change(within(form).getAllByLabelText(M.fieldName)[0], { target: { value: 'income' } });
    expect(insertButton(form).disabled).toBe(false);
    fireEvent.click(within(form).getByRole('button', { name: M.addFieldRow }));
    fireEvent.change(within(form).getAllByLabelText(M.fieldName)[1], { target: { value: 'income' } });
    expect(insertButton(form).disabled).toBe(true);
    expect(within(form).getByRole('alert').textContent).toBe(M.duplicateName);
  });

  it('与已有结构体 / 别名同名（忽略大小写）被拒', () => {
    renderTab(fakeEditor(SOURCE), SOURCE);
    const form = openStruct();
    fireEvent.change(within(form).getByLabelText(M.structName), { target: { value: 'PERSON' } });
    fireEvent.change(within(form).getAllByLabelText(M.fieldName)[0], { target: { value: 'x' } });
    expect(insertButton(form).disabled).toBe(true);
    expect(within(form).getByRole('alert').textContent).toBe(M.duplicateName);
  });

  it('类型别名名无效：禁用插入', () => {
    renderTab(fakeEditor(SOURCE), SOURCE);
    fireEvent.click(screen.getByRole('button', { name: M.newTypeAlias }));
    const form = screen.getByRole('form', { name: M.newTypeAlias });
    fireEvent.change(within(form).getByLabelText(M.aliasName), { target: { value: 'a.b' } });
    expect(insertButton(form).disabled).toBe(true);
    expect(within(form).getByRole('alert').textContent).toBe(M.invalidName);
  });

  it('添加字段：已有字段重名被拒', () => {
    renderTab(fakeEditor(SOURCE), SOURCE);
    fireEvent.click(screen.getByRole('button', { name: ADD_FIELD_PERSON }));
    const form = screen.getByRole('form', { name: ADD_FIELD_PERSON });
    fireEvent.change(within(form).getByLabelText(M.fieldName), { target: { value: 'age' } });
    expect(insertButton(form).disabled).toBe(true);
    expect(within(form).getByRole('alert').textContent).toBe(M.duplicateName);
  });
});

describe('ModelTab 类型下拉含枚举', () => {
  it('Define X as one of … 声明的枚举可作为字段类型', () => {
    const src = `${SOURCE}\n\nDefine Level as one of Low, High.`;
    renderTab(fakeEditor(src), src);
    fireEvent.click(screen.getByRole('button', { name: M.newStruct }));
    const select = screen.getAllByLabelText(M.fieldType)[0] as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toContain('Level');
  });
});

describe('ModelTab 没有字段的结构体', () => {
  it('添加字段不静默：显示说明且不写编辑器', () => {
    const original = vi.mocked(buildModelOutline).getMockImplementation()!;
    // 只替换编辑器源码的大纲；名字往返校验用的最小模块仍走真实解析
    vi.mocked(buildModelOutline).mockImplementation((src, lexicon) =>
      src === 'Define Empty.'
        ? {
            structs: [{ name: 'Empty', span: { start: { line: 1, col: 1 }, end: { line: 1, col: 14 } }, fields: [] }],
            enums: [],
            typeAliases: [],
            imports: [],
          }
        : original(src, lexicon),
    );
    const editor = fakeEditor('Define Empty.');
    renderTab(editor, 'Define Empty.');
    const label = M.addFieldTo.replace('{name}', 'Empty');
    fireEvent.click(screen.getByRole('button', { name: label }));
    const form = screen.getByRole('form', { name: label });
    fireEvent.change(within(form).getByLabelText(M.fieldName), { target: { value: 'x' } });
    fireEvent.click(within(form).getByRole('button', { name: M.insert }));
    expect(editor.executeEdits).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe(M.emptyStruct);
    vi.mocked(buildModelOutline).mockImplementation(original);
  });
});

describe('ModelTab 名字往返校验（四种语言）', () => {
  const openStruct = () => {
    fireEvent.click(screen.getByRole('button', { name: M.newStruct }));
    return screen.getByRole('form', { name: M.newStruct });
  };
  const insertButton = (form: HTMLElement) => within(form).getByRole('button', { name: M.insert }) as HTMLButtonElement;
  const typeInto = (form: HTMLElement, label: string, value: string, index = 0) =>
    fireEvent.change(within(form).getAllByLabelText(label)[index], { target: { value } });

  /** 新建结构体：结构体名合法，字段名逐个试；被拒时显示 reservedName，换成合法名后可插入。 */
  const expectFieldNamesReserved = (lexicon: Lexicon, structName: string, okField: string, reserved: string[]) => {
    renderTab(fakeEditor(''), '', lexicon);
    const form = openStruct();
    typeInto(form, M.structName, structName);
    for (const name of reserved) {
      typeInto(form, M.fieldName, name);
      expect(insertButton(form).disabled, name).toBe(true);
      expect(within(form).getByRole('alert').textContent, name).toBe(M.reservedName);
    }
    typeInto(form, M.fieldName, okField);
    expect(insertButton(form).disabled).toBe(false);
    expect(within(form).queryByRole('alert')).toBeNull();
  };

  it('en-US：小写关键词作字段名被拒（aster-lang-ts 3.9.0 D4，与 core 一致）', () => {
    expectFieldNamesReserved(EN_US, 'Applicant', 'amount', ['with', 'and', 'as']);
  });

  it('en-US：不是关键词的小写词（rule）在字段位置照常通过', () => {
    renderTab(fakeEditor(''), '', EN_US);
    const form = openStruct();
    typeInto(form, M.structName, 'Applicant');
    typeInto(form, M.fieldName, 'rule');
    expect(insertButton(form).disabled).toBe(false);
  });

  it('de-DE：冠词 der / die 作字段名被拒', () => {
    expectFieldNamesReserved(DE_DE, 'Kunde', 'alter', ['der', 'die']);
  });

  it('zh-CN：关键词作字段名被拒', () => {
    expectFieldNamesReserved(ZH_CN, '客户', '姓名', ['定义', '规则', '文本', '整数', '返回']);
  });

  it('hi-IN：关键词作字段名被拒', () => {
    expectFieldNamesReserved(HI_IN, 'ग्राहक', 'नाम', ['परिभाषित', 'नियम', 'पाठ']);
  });

  it('多行字段：第二行的保留词同样被拒', () => {
    renderTab(fakeEditor(''), '', ZH_CN);
    const form = openStruct();
    typeInto(form, M.structName, '客户');
    typeInto(form, M.fieldName, '姓名');
    fireEvent.click(within(form).getByRole('button', { name: M.addFieldRow }));
    typeInto(form, M.fieldName, '规则', 1);
    expect(insertButton(form).disabled).toBe(true);
    expect(within(form).getByRole('alert').textContent).toBe(M.reservedName);
  });

  it('只填了保留字段名、结构体名尚空时即提示', () => {
    renderTab(fakeEditor(''), '', DE_DE);
    const form = openStruct();
    typeInto(form, M.fieldName, 'der');
    expect(within(form).getByRole('alert').textContent).toBe(M.reservedName);
  });

  it.each([
    ['de-DE', DE_DE, ['der', 'die'], 'Kunde', 'name'],
    ['zh-CN', ZH_CN, ['定义', '文本'], '客户', '姓名'],
  ] as const)('%s：不能作类型引用的结构体名被拒', (_, lexicon, reserved, ok, field) => {
    renderTab(fakeEditor(''), '', lexicon);
    const form = openStruct();
    typeInto(form, M.fieldName, field);
    for (const name of reserved) {
      typeInto(form, M.structName, name);
      expect(insertButton(form).disabled, name).toBe(true);
      expect(within(form).getByRole('alert').textContent, name).toBe(M.reservedName);
    }
    typeInto(form, M.structName, ok);
    expect(insertButton(form).disabled).toBe(false);
    expect(within(form).queryByRole('alert')).toBeNull();
  });

  it('hi-IN：关键词作结构体名被拒', () => {
    renderTab(fakeEditor(''), '', HI_IN);
    const form = openStruct();
    typeInto(form, M.fieldName, 'नाम');
    typeInto(form, M.structName, 'परिभाषित');
    expect(insertButton(form).disabled).toBe(true);
    expect(within(form).getByRole('alert').textContent).toBe(M.reservedName);
  });

  it('de-DE：冠词作类型别名名被拒', () => {
    renderTab(fakeEditor(''), '', DE_DE);
    fireEvent.click(screen.getByRole('button', { name: M.newTypeAlias }));
    const form = screen.getByRole('form', { name: M.newTypeAlias });
    for (const name of ['der', 'die']) {
      typeInto(form, M.aliasName, name);
      expect(insertButton(form).disabled, name).toBe(true);
      expect(within(form).getByRole('alert').textContent, name).toBe(M.reservedName);
    }
    typeInto(form, M.aliasName, 'Punktzahl');
    expect(insertButton(form).disabled).toBe(false);
  });

  it.each([
    ['en-US', EN_US, 'applicant', 'Applicant'],
    ['de-DE', DE_DE, 'kunde', 'Kunde'],
    ['de-DE（变音符）', DE_DE, 'ärger', 'Ärger'],
    ['zh-CN（拉丁名）', ZH_CN, 'applicant', 'Applicant'],
    ['hi-IN（拉丁名）', HI_IN, 'applicant', 'Applicant'],
  ] as const)('%s：小写起首的结构体名提示大小写而非保留词，改成大写后可提交', (_, lexicon, lower, upper) => {
    renderTab(fakeEditor(''), '', lexicon);
    const form = openStruct();
    typeInto(form, M.fieldName, lexicon === ZH_CN ? '姓名' : lexicon === HI_IN ? 'नाम' : 'name');
    typeInto(form, M.structName, lower);
    expect(insertButton(form).disabled).toBe(true);
    expect(within(form).getByRole('alert').textContent).toBe(M.lowercaseType);
    typeInto(form, M.structName, upper);
    expect(insertButton(form).disabled).toBe(false);
    expect(within(form).queryByRole('alert')).toBeNull();
  });

  it.each([
    ['en-US', EN_US, 'score', 'Score'],
    ['de-DE', DE_DE, 'punktzahl', 'Punktzahl'],
  ] as const)('%s：小写起首的类型别名名提示大小写', (_, lexicon, lower, upper) => {
    renderTab(fakeEditor(''), '', lexicon);
    fireEvent.click(screen.getByRole('button', { name: M.newTypeAlias }));
    const form = screen.getByRole('form', { name: M.newTypeAlias });
    typeInto(form, M.aliasName, lower);
    expect(insertButton(form).disabled).toBe(true);
    expect(within(form).getByRole('alert').textContent).toBe(M.lowercaseType);
    typeInto(form, M.aliasName, upper);
    expect(insertButton(form).disabled).toBe(false);
  });

  it('de-DE：小写冠词作类型名仍报保留词（大写后同样被拒）', () => {
    renderTab(fakeEditor(''), '', DE_DE);
    const form = openStruct();
    typeInto(form, M.fieldName, 'name');
    typeInto(form, M.structName, 'der');
    expect(within(form).getByRole('alert').textContent).toBe(M.reservedName);
  });

  it('非拉丁字母的小写名（希腊字母）按「不是单个词」处理，不提示大小写', () => {
    renderTab(fakeEditor(''), '', EN_US);
    const form = openStruct();
    typeInto(form, M.fieldName, 'name');
    typeInto(form, M.structName, '\u03c3');
    expect(within(form).getByRole('alert').textContent).toBe(M.invalidName);
  });

  it('字段名不受类型名大小写规则影响：小写字段名可提交', () => {
    renderTab(fakeEditor(''), '', EN_US);
    const form = openStruct();
    typeInto(form, M.structName, 'Applicant');
    typeInto(form, M.fieldName, 'income');
    expect(insertButton(form).disabled).toBe(false);
  });

  it.each([
    ['zh-CN', ZH_CN, '客户', '姓名', ['定义', '规则', '文本', '整数', '返回'], '年龄'],
    ['hi-IN', HI_IN, 'ग्राहक', 'नाम', ['परिभाषित', 'नियम', 'पाठ'], 'उम्र'],
    ['de-DE', DE_DE, 'Kunde', 'name', ['der', 'die'], 'alter'],
  ] as const)('%s：为已有结构体添加保留字段名被拒', (_, lexicon, struct, field, reserved, ok) => {
    const src = `${lexicon.keywords.MODULE_DECL} demo${lexicon.punctuation.statementEnd}\n\n${buildStructSource(lexicon, {
      name: struct,
      fields: [{ name: field, type: lexicon.keywords.TEXT }],
    })}`;
    renderTab(fakeEditor(src), src, lexicon);
    const label = M.addFieldTo.replace('{name}', struct);
    fireEvent.click(screen.getByRole('button', { name: label }));
    const form = screen.getByRole('form', { name: label });
    for (const name of reserved) {
      typeInto(form, M.fieldName, name);
      expect(insertButton(form).disabled, name).toBe(true);
      expect(within(form).getByRole('alert').textContent, name).toBe(M.reservedName);
    }
    typeInto(form, M.fieldName, ok);
    expect(insertButton(form).disabled).toBe(false);
  });
});

describe('ModelTab 重名口径与编译器一致', () => {
  it('Unicode 大小写折叠（foldKey）：Perſon 与已有 Person 视为重名（toLocaleLowerCase 看不出）', () => {
    renderTab(fakeEditor(SOURCE), SOURCE);
    fireEvent.click(screen.getByRole('button', { name: M.newTypeAlias }));
    const form = screen.getByRole('form', { name: M.newTypeAlias });
    fireEvent.change(within(form).getByLabelText(M.aliasName), { target: { value: 'Per\u017fon' } });
    expect((within(form).getByRole('button', { name: M.insert }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(form).getByRole('alert').textContent).toBe(M.duplicateName);
  });

  it('导入别名占用类型名：与 Use lib as L. 同名的类型别名被拒', () => {
    renderTab(fakeEditor(SOURCE), SOURCE);
    fireEvent.click(screen.getByRole('button', { name: M.newTypeAlias }));
    const form = screen.getByRole('form', { name: M.newTypeAlias });
    fireEvent.change(within(form).getByLabelText(M.aliasName), { target: { value: 'L' } });
    expect((within(form).getByRole('button', { name: M.insert }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(form).getByRole('alert').textContent).toBe(M.duplicateName);
  });

  it('en-US 小写起首的类型名作类型引用报 E055（aster-lang-ts 3.6.0），往返失败、不能插入', () => {
    renderTab(fakeEditor(SOURCE), SOURCE);
    fireEvent.click(screen.getByRole('button', { name: M.newTypeAlias }));
    const form = screen.getByRole('form', { name: M.newTypeAlias });
    fireEvent.change(within(form).getByLabelText(M.aliasName), { target: { value: 'rating' } });
    expect((within(form).getByRole('button', { name: M.insert }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(form).getByRole('alert').textContent).toBe(M.lowercaseType);
  });
});

describe('ModelTab 重名口径（四种语言）：foldKey 折叠 + 导入别名', () => {
  // [locale, lexicon, 导入别名, 已有结构体名, 视为重名的新类型名…]
  it.each([
    // 拉丁语言的候选名大写起首：小写起首的类型名在 ts 3.6.0 作类型引用报 E055，先于重名判定被拒
    ['en-US', EN_US, 'Lib', 'Café', ['LIB', 'CAF\u00c9']],
    ['de-DE', DE_DE, 'Bib', 'Kunde', ['BIB', 'KUNDE']],
    ['zh-CN', ZH_CN, '库', '客户', ['库', '客户']],
    ['hi-IN', HI_IN, 'पुस्तक', 'क़ीमत', ['पुस्तक', 'क़ीमत']],
  ] as const)('%s', (_, lexicon, importAlias, struct, duplicates) => {
    const k = lexicon.keywords;
    const end = lexicon.punctuation.statementEnd;
    const src = [
      `${k.MODULE_DECL} demo${end}`,
      `${k.IMPORT.charAt(0).toUpperCase()}${k.IMPORT.slice(1)} lib ${k.IMPORT_ALIAS} ${importAlias}${end}`,
      buildStructSource(lexicon, { name: struct, fields: [{ name: 'x', type: k.TEXT }] }),
    ].join('\n\n');
    renderTab(fakeEditor(src), src, lexicon);
    fireEvent.click(screen.getByRole('button', { name: M.newTypeAlias }));
    const form = screen.getByRole('form', { name: M.newTypeAlias });
    for (const name of duplicates) {
      fireEvent.change(within(form).getByLabelText(M.aliasName), { target: { value: name } });
      expect((within(form).getByRole('button', { name: M.insert }) as HTMLButtonElement).disabled, name).toBe(true);
      expect(within(form).getByRole('alert').textContent, name).toBe(M.duplicateName);
    }
  });
});

// 名字自动转义（ADR 0058 修订 3 E1）：开关打开时生成 `name` 并提示「已自动转义」；开关关闭时与引入转义之前逐字节相同。
describe('ModelTab 名字自动转义（开关 authoring.name_escape.enabled）', () => {
  const ZH = '模块 demo。\n\n定义 人员 包含 姓名 作为 文本。\n';
  const renderZh = (editor: ReturnType<typeof fakeEditor>, nameEscape?: boolean) =>
    render(
      <IntlClientProvider locale="zh" messages={messages as never}>
        <ModelTab editor={editor as never} source={ZH} lexicon={ZH_CN} {...(nameEscape === undefined ? {} : { nameEscape })} />
      </IntlClientProvider>,
    );
  const fillStruct = (structName: string, fieldName: string) => {
    fireEvent.click(screen.getByRole('button', { name: M.newStruct }));
    const form = screen.getByRole('form', { name: M.newStruct });
    fireEvent.change(within(form).getByLabelText(M.structName), { target: { value: structName } });
    fireEvent.change(within(form).getAllByLabelText(M.fieldName)[0], { target: { value: fieldName } });
    return form;
  };
  const insertButton = (form: HTMLElement) => within(form).getByRole('button', { name: M.insert }) as HTMLButtonElement;
  const insertedText = (editor: ReturnType<typeof fakeEditor>) =>
    (editor.executeEdits.mock.calls[0] as unknown as [string, Array<{ text: string }>])[1][0].text;

  it('开关打开：关键词作字段名 → 「已自动转义」提示，插入 `版本`', () => {
    const editor = fakeEditor(ZH);
    renderZh(editor, true);
    const form = fillStruct('软件', '版本');
    expect(insertButton(form).disabled).toBe(false);
    expect(within(form).queryByRole('alert')).toBeNull();
    expect(within(form).getByRole('status').textContent).toBe(M.autoEscaped.replace('{written}', '`版本`'));
    fireEvent.click(insertButton(form));
    expect(insertedText(editor)).toBe('\n定义 软件 包含 `版本` 作为 文本。\n');
  });

  it('开关打开：关键词作结构体名，再作字段类型时类型下拉写成转义', () => {
    const src = '模块 demo。\n\n定义 `如果` 包含 x 作为 文本。\n';
    const editor = fakeEditor(src);
    render(
      <IntlClientProvider locale="zh" messages={messages as never}>
        <ModelTab editor={editor as never} source={src} lexicon={ZH_CN} nameEscape />
      </IntlClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: M.newStruct }));
    const form = screen.getByRole('form', { name: M.newStruct });
    fireEvent.change(within(form).getByLabelText(M.structName), { target: { value: '申请' } });
    fireEvent.change(within(form).getAllByLabelText(M.fieldName)[0], { target: { value: '条件' } });
    fireEvent.change(within(form).getAllByLabelText(M.fieldType)[0], { target: { value: '如果' } });
    fireEvent.click(insertButton(form));
    expect(insertedText(editor)).toBe('\n定义 申请 包含 条件 作为 `如果`。\n');
  });

  it('开关打开：阻止提交的问题优先于自动转义提示', () => {
    renderZh(fakeEditor(ZH), true);
    const form = fillStruct('人员', '版本');
    expect(insertButton(form).disabled).toBe(true);
    expect(within(form).getByRole('alert').textContent).toBe(M.duplicateName);
  });

  it.each([undefined, false])('开关关闭（%s）：与引入转义之前一致——报保留词、禁用插入、不转义', (flag) => {
    const editor = fakeEditor(ZH);
    renderZh(editor, flag);
    const form = fillStruct('软件', '版本');
    expect(insertButton(form).disabled).toBe(true);
    expect(within(form).getByRole('alert').textContent).toBe(M.reservedName);
    expect(within(form).queryByRole('status')).toBeNull();
    // 合法名字的产出与 buildStructSource 逐字节相同
    fireEvent.change(within(form).getAllByLabelText(M.fieldName)[0], { target: { value: ' 年龄 ' } });
    fireEvent.click(insertButton(form));
    expect(insertedText(editor)).toBe(
      `\n${buildStructSource(ZH_CN, { name: '软件', fields: [{ name: ' 年龄 ', type: '文本' }] })}\n`,
    );
  });
});
