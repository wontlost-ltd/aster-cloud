import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PolicyAliasPanel } from './policy-alias-panel';
import { extractReservedAliasSets, getLexicon } from '@/lib/aster-lexicon';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (key === 'configuredCount') return `${values?.count ?? 0} configured`;
    if (key === 'inputLabel') return `Aliases for ${values?.kind ?? ''}`;
    // 校验文案带参数时把参数拼进去，便于断言具体是哪条问题、归到哪两个 kind。
    if (key.startsWith('errors.') && values) {
      return `${key}(${values.alias ?? ''}|${values.kind ?? ''}|${values.otherKind ?? ''})`;
    }
    return key;
  },
}));

afterEach(cleanup);

const reservedSets = extractReservedAliasSets(getLexicon('en-US'));

function renderPanel(allowStructural: boolean) {
  const onChange = vi.fn();
  render(
    <PolicyAliasPanel
      aliasSet={{}}
      locale="en-US"
      reservedSets={reservedSets}
      allowStructural={allowStructural}
      onChange={onChange}
      expanded
      onExpandedChange={vi.fn()}
    />,
  );
  return { onChange };
}

describe('PolicyAliasPanel', () => {
  it('renders arithmetic and comparison operator groups', () => {
    renderPanel(false);
    expect(screen.getByText('groupArithmetic')).toBeInTheDocument();
    expect(screen.getByText('groupComparison')).toBeInTheDocument();
    expect(screen.getByText('kinds.plus')).toBeInTheDocument();
    expect(screen.getByText('kinds.lessThan')).toBeInTheDocument();
  });

  it('locks structural aliases without entitlement', () => {
    renderPanel(false);
    expect(screen.getByText('groupStructural')).toBeInTheDocument();
    expect(screen.getByText('structuralLocked')).toBeInTheDocument();
    expect(screen.getByLabelText('Aliases for kinds.module')).toBeDisabled();
  });

  it('shows structural aliases when entitlement is present', () => {
    renderPanel(true);
    expect(screen.getByText('kinds.module')).toBeInTheDocument();
    expect(screen.getByLabelText('Aliases for kinds.module')).not.toBeDisabled();
  });

  it('shows row validation errors for unsafe single-word aliases', () => {
    render(
      <PolicyAliasPanel
        aliasSet={{ TIMES: ['multiply'] }}
        locale="en-US"
        reservedSets={reservedSets}
        allowStructural={false}
        onChange={vi.fn()}
        expanded
        onExpandedChange={vi.fn()}
      />,
    );
    // 本地化键而非中文诊断原文（#609）。
    expect(screen.getByRole('alert')).toHaveTextContent('errors.singleWord(multiply|kinds.times|');
    expect(screen.getByRole('alert')).not.toHaveTextContent('多词');
  });

  it('normalizes comma-separated input before emitting changes', () => {
    const { onChange } = renderPanel(false);
    fireEvent.change(screen.getByLabelText('Aliases for kinds.times'), {
      target: { value: 'Product Of, Times By' },
    });
    expect(onChange).toHaveBeenCalledWith({ TIMES: ['product of', 'times by'] });
  });

  it('#601：逐字输入多词别名时保留空格与逗号，并实时解析回传', () => {
    const changes: Record<string, string[]>[] = [];
    function Harness() {
      const [aliasSet, setAliasSet] = useState<Record<string, string[]>>({});
      return (
        <PolicyAliasPanel
          aliasSet={aliasSet}
          locale="en-US"
          reservedSets={reservedSets}
          allowStructural={false}
          onChange={(next) => {
            changes.push(next);
            setAliasSet(next);
          }}
          expanded
          onExpandedChange={vi.fn()}
        />
      );
    }
    render(<Harness />);
    const input = screen.getByLabelText('Aliases for kinds.times') as HTMLInputElement;
    const typed = 'multiplied by, scaled by';
    for (let i = 1; i <= typed.length; i += 1) {
      fireEvent.change(input, { target: { value: typed.slice(0, i) } });
      // 每一次按键后输入框都保持用户键入的原文（末尾空格/逗号不被吞掉）。
      expect(input.value).toBe(typed.slice(0, i));
    }
    expect(changes.at(-1)).toEqual({ TIMES: ['multiplied by', 'scaled by'] });

    // 失焦后回到规范化展示。
    fireEvent.blur(input);
    expect(input.value).toBe('multiplied by, scaled by');
  });

  it('#601：失焦后显示解析后的规范形', () => {
    function Harness() {
      const [aliasSet, setAliasSet] = useState<Record<string, string[]>>({});
      return (
        <PolicyAliasPanel
          aliasSet={aliasSet}
          locale="en-US"
          reservedSets={reservedSets}
          allowStructural={false}
          onChange={setAliasSet}
          expanded
          onExpandedChange={vi.fn()}
        />
      );
    }
    render(<Harness />);
    const input = screen.getByLabelText('Aliases for kinds.times') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  Multiplied   BY ,, ' } });
    expect(input.value).toBe('  Multiplied   BY ,, ');
    fireEvent.blur(input);
    expect(input.value).toBe('multiplied by');
  });

  it('#613：跨 kind 重复别名在两行都显示明确错误', () => {
    render(
      <PolicyAliasPanel
        aliasSet={{ TIMES: ['multiplied by'], MODULO: ['multiplied by'] }}
        locale="en-US"
        reservedSets={reservedSets}
        allowStructural={false}
        onChange={vi.fn()}
        expanded
        onExpandedChange={vi.fn()}
      />,
    );
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(2);
    for (const alert of alerts) {
      expect(alert).toHaveTextContent('errors.duplicate(multiplied by|kinds.modulo|kinds.times)');
    }
    expect(screen.getByLabelText('Aliases for kinds.times')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Aliases for kinds.modulo')).toHaveAttribute('aria-invalid', 'true');
  });

  it('#601：编辑中外部重置/恢复 aliasSet 时输入框同步外部值', () => {
    let setExternal: (next: Record<string, string[]>) => void = () => {};
    function Harness() {
      const [aliasSet, setAliasSet] = useState<Record<string, string[]>>({});
      setExternal = setAliasSet;
      return (
        <PolicyAliasPanel
          aliasSet={aliasSet}
          locale="en-US"
          reservedSets={reservedSets}
          allowStructural={false}
          onChange={setAliasSet}
          expanded
          onExpandedChange={vi.fn()}
        />
      );
    }
    render(<Harness />);
    const input = screen.getByLabelText('Aliases for kinds.times') as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: 'multiplied ' } });
    expect(input.value).toBe('multiplied ');

    // 仍处于聚焦状态时外部恢复草稿。
    act(() => setExternal({ TIMES: ['scaled by'] }));
    expect(input.value).toBe('scaled by');

    // 外部清空。
    act(() => setExternal({}));
    expect(input.value).toBe('');

    // 之后继续逐字输入仍保留原文。
    fireEvent.change(input, { target: { value: 'times by ' } });
    expect(input.value).toBe('times by ');
  });
});
