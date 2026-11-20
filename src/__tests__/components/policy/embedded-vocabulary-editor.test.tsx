// 「本策略」内嵌词汇编辑器（ADR 0060 §7.5，计划 T11）：五种 kind 的增删改、field / enum_value 必填所属类型、
// literal 行的「展开为字符串」、按错误码本地化的即时校验、32 条上限、只读模式没有输入控件。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import zhBase from '@aster-cloud/ui-messages/zh-CN.json';
import { IntlClientProvider } from '@/i18n/intl-client-provider';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';
import { EmbeddedVocabularyEditor } from '@/components/policy/policy-form/embedded-vocabulary-editor';
import type { EmbeddedTerm, EmbeddedVocabulary } from '@/lib/policy-embedded-vocabulary';

const messages = deepMergeMessages(zhBase as Record<string, unknown>, DEMO_SUPPLEMENT.zh) as {
  policyEditor: { embeddedTerms: Record<string, string> & { errors: Record<string, string> } };
};
const M = messages.policyEditor.embeddedTerms;

const POEM: EmbeddedVocabulary = {
  v: 1,
  terms: [
    { kind: 'literal', localized: '思故乡', canonical: '静夜思' },
    { kind: 'struct', localized: '望明月', canonical: 'Text' },
  ],
};

function renderEditor(props: Partial<Parameters<typeof EmbeddedVocabularyEditor>[0]> = {}) {
  const onChange = vi.fn();
  const view = render(
    <IntlClientProvider locale="zh" messages={messages as never}>
      <EmbeddedVocabularyEditor
        value={POEM}
        onChange={onChange}
        locale="zh-CN"
        aliasSet={null}
        parentOptions={['Text', 'Tier']}
        {...props}
      />
    </IntlClientProvider>,
  );
  return { onChange, ...view };
}

const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const addButton = () => screen.getByRole('button', { name: M.add });
const lastTerms = (onChange: ReturnType<typeof vi.fn>) => (onChange.mock.calls.at(-1)![0] as EmbeddedVocabulary).terms;

afterEach(cleanup);

describe('EmbeddedVocabularyEditor', () => {
  it('列出词条：字面量行显示「展开为字符串」与展开值，计数 n / 32', () => {
    renderEditor();
    expect(screen.getByRole('heading', { name: /本策略/ })).toBeTruthy();
    expect(screen.getByText('2 / 32 条')).toBeTruthy();
    const rows = screen.getAllByTestId('embedded-term');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText(M.expandsTo)).toBeTruthy();
    expect(within(rows[0]!).getByText('"静夜思"')).toBeTruthy();
    expect(within(rows[1]!).getByText('Text')).toBeTruthy();
    expect(within(rows[1]!).queryByText(M.expandsTo)).toBeNull();
  });

  it.each<[EmbeddedTerm['kind'], string, string, string | undefined]>([
    ['literal', '低头', 'bow', undefined],
    ['struct', '床前', 'Bed', undefined],
    ['function', '举头', 'raise', undefined],
    ['field', '光', 'light', 'Text'],
    ['enum_value', '金', 'Gold', 'Tier'],
  ])('新增 %s', (kind, localized, canonical, parent) => {
    const { onChange } = renderEditor();
    fireEvent.change(screen.getByLabelText(M.kindLabel), { target: { value: kind } });
    fill(M.localizedLabel, localized);
    fill(kind === 'literal' ? M.literalLabel : M.canonicalLabel, canonical);
    if (parent) {
      // 未填所属类型不能提交
      expect((addButton() as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText(M.requiredParent)).toBeTruthy();
      fill(M.parentLabel, parent);
    }
    fireEvent.click(addButton());
    expect(lastTerms(onChange)).toEqual([...POEM.terms, { kind, localized, canonical, ...(parent ? { parent } : {}) }]);
  });

  it('编辑与删除', () => {
    const { onChange } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: '编辑“望明月”' }));
    expect((screen.getByLabelText(M.localizedLabel) as HTMLInputElement).value).toBe('望明月');
    fill(M.canonicalLabel, 'Moon');
    fireEvent.click(screen.getByRole('button', { name: M.update }));
    expect(lastTerms(onChange)).toEqual([POEM.terms[0], { kind: 'struct', localized: '望明月', canonical: 'Moon' }]);

    fireEvent.click(screen.getByRole('button', { name: '删除“思故乡”' }));
    expect(lastTerms(onChange)).toEqual([POEM.terms[1]]);
  });

  it.each<[string, Partial<Record<'kind' | 'localized' | 'canonical', string>>, string]>([
    ['写法等于关键词', { localized: '返回', canonical: 'x' }, 'embedded_vocabulary_shadows_keyword'],
    ['触发词重复', { localized: '思故乡', canonical: '别的' }, 'embedded_vocabulary_duplicate'],
    ['字面量含无从转义的定界符', { localized: '低头', canonical: 'a「b' }, 'embedded_vocabulary_invalid'],
    ['结构体规范名非 ASCII', { kind: 'struct', localized: '床前', canonical: '床' }, 'embedded_vocabulary_invalid'],
    ['写法超过 32 字符', { localized: '字'.repeat(33), canonical: 'x' }, 'embedded_vocabulary_too_large'],
  ])('即时校验：%s → 本地化错误，不能提交', (_label, input, code) => {
    const { onChange } = renderEditor();
    if (input.kind) fireEvent.change(screen.getByLabelText(M.kindLabel), { target: { value: input.kind } });
    fill(M.localizedLabel, input.localized!);
    fill(input.kind === 'struct' ? M.canonicalLabel : M.literalLabel, input.canonical!);
    expect(screen.getByText(M.errors[code]!)).toBeTruthy();
    expect(screen.getByLabelText(M.localizedLabel).getAttribute('aria-invalid')).toBe('true');
    expect((addButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(addButton().closest('form')!);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('写法与本策略的关键词别名同形 → shadows_keyword（整份词汇的提示也出现在列表上方）', () => {
    renderEditor({
      value: { v: 1, terms: [{ kind: 'literal', localized: '接 着', canonical: 'x' }] },
      aliasSet: { PLUS: ['接 着'] },
    });
    expect(screen.getByRole('alert').textContent).toBe(M.errors.embedded_vocabulary_shadows_keyword);
  });

  it('满 32 条：不能再新增', () => {
    const terms: EmbeddedTerm[] = Array.from({ length: 32 }, (_, i) => ({ kind: 'literal', localized: `词${i}`, canonical: `v${i}` }));
    renderEditor({ value: { v: 1, terms } });
    expect(screen.getByText(M.capReached.replace('{max}', '32'))).toBeTruthy();
    expect((addButton() as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText(M.localizedLabel) as HTMLInputElement).disabled).toBe(true);
  });

  it('只读：只有列表，没有任何输入控件与按钮', () => {
    const { container } = renderEditor({ readOnly: true, onChange: undefined });
    expect(screen.getAllByTestId('embedded-term')).toHaveLength(2);
    expect(screen.getByText(M.readOnlyNote)).toBeTruthy();
    expect(container.querySelectorAll('input, select, textarea, button, form')).toHaveLength(0);
  });

  it('无词条：显示空提示', () => {
    renderEditor({ value: null });
    expect(screen.getByText(M.empty)).toBeTruthy();
    expect(screen.getByText('0 / 32 条')).toBeTruthy();
  });
});
