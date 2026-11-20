/*
 * 只读源码视图：标签顺序恒为 canonical、display（ADR 0058 §7.7 第 1 条，计划 T7）；
 * 缺省选中 canonical（审批 / 评审视图，裁决 R15），阅读视图可传 defaultTab="display"（修订 1 A1）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('next-intl', () => ({ useTranslations: (ns: string) => (key: string) => `${ns}.${key}` }));

import { LayoutReadTabs } from '@/components/policy/layout/layout-read-tabs';
import { LAYOUT_DISPLAY, LAYOUT_SOURCE, STORED_INCONSISTENT, STORED_OK } from '@/__tests__/fixtures/layout-read-fixture';

afterEach(() => cleanup());

const canonical = <pre data-testid="canonical">{LAYOUT_SOURCE}</pre>;
const displayRegion = () => screen.queryByRole('region', { name: 'policyLayout.displayLabel' });

describe('LayoutReadTabs', () => {
  it('none：DOM 与直接渲染 children 相同', () => {
    const plain = render(<div>{canonical}</div>).container.innerHTML;
    cleanup();
    const wrapped = render(<div><LayoutReadTabs layout={{ status: 'none' }}>{canonical}</LayoutReadTabs></div>).container.innerHTML;
    expect(wrapped).toBe(plain);
  });

  it('ok：第一个标签是 canonical 且默认选中，display 未渲染', () => {
    render(<LayoutReadTabs layout={STORED_OK}>{canonical}</LayoutReadTabs>);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['policyLayout.tabCanonical', 'policyLayout.tabDisplay']);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs[1].getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('tablist', { name: 'policyLayout.tabsLabel' })).toBeDefined();
    expect(screen.getByRole('tabpanel', { name: 'policyLayout.tabCanonical' }).contains(screen.getByTestId('canonical'))).toBe(true);
    expect(displayRegion()).toBeNull();
  });

  it('ok：点击次级标签后才显示 display，canonical 面板隐藏', () => {
    render(<LayoutReadTabs layout={STORED_OK}>{canonical}</LayoutReadTabs>);
    fireEvent.click(screen.getByRole('tab', { name: 'policyLayout.tabDisplay' }));
    expect(displayRegion()!.textContent).toBe(LAYOUT_DISPLAY);
    expect(screen.getByText('policyLayout.displayNote')).toBeDefined();
    expect(screen.getByTestId('canonical').closest('[role="tabpanel"]')!.hasAttribute('hidden')).toBe(true);
  });

  it('键盘：方向键与 Home / End 切换并移动焦点，未选中的标签不在 Tab 序列里', () => {
    render(<LayoutReadTabs layout={STORED_OK}>{canonical}</LayoutReadTabs>);
    const [first, second] = screen.getAllByRole('tab');
    expect([first.tabIndex, second.tabIndex]).toEqual([0, -1]);
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(second.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(second);
    expect([first.tabIndex, second.tabIndex]).toEqual([-1, 0]);
    fireEvent.keyDown(second, { key: 'Home' });
    expect(first.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(first, { key: 'End' });
    expect(second.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(second, { key: 'ArrowLeft' });
    expect(first.getAttribute('aria-selected')).toBe('true');
  });

  it('defaultTab=display：标签顺序不变，display 默认选中并渲染，canonical 面板隐藏', () => {
    render(<LayoutReadTabs layout={STORED_OK} defaultTab="display">{canonical}</LayoutReadTabs>);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => [t.textContent, t.getAttribute('aria-selected'), t.tabIndex])).toEqual([
      ['policyLayout.tabCanonical', 'false', -1],
      ['policyLayout.tabDisplay', 'true', 0],
    ]);
    expect(displayRegion()!.textContent).toBe(LAYOUT_DISPLAY);
    expect(screen.getByText('policyLayout.displayNote')).toBeDefined();
    expect(screen.getByTestId('canonical').closest('[role="tabpanel"]')!.hasAttribute('hidden')).toBe(true);
    // 切回 canonical 仍可用，键盘约定不变
    fireEvent.keyDown(tabs[1], { key: 'Home' });
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs[0]);
    expect(displayRegion()).toBeNull();
  });

  it('defaultTab=canonical 与不传相同（除 useId 生成的 id 外 DOM 一致）', () => {
    // useId 每次挂载取值不同，比较前把 id 引用归一
    const normalize = (html: string) => {
      const ids = [...new Set([...html.matchAll(/(?:id|aria-controls|aria-labelledby)="([^"]+)"/g)].map((m) => m[1]))];
      return ids.reduce((out, id, i) => out.split(id).join(`ID${i}`), html);
    };
    const implicit = normalize(render(<LayoutReadTabs layout={STORED_OK}>{canonical}</LayoutReadTabs>).container.innerHTML);
    cleanup();
    const explicit = normalize(
      render(<LayoutReadTabs layout={STORED_OK} defaultTab="canonical">{canonical}</LayoutReadTabs>).container.innerHTML,
    );
    expect(explicit).toBe(implicit);
  });

  it.each(['canonical', 'display'] as const)('none + defaultTab=%s：DOM 仍与直接渲染 children 相同', (defaultTab) => {
    const plain = render(<div>{canonical}</div>).container.innerHTML;
    cleanup();
    const wrapped = render(<div><LayoutReadTabs layout={{ status: 'none' }} defaultTab={defaultTab}>{canonical}</LayoutReadTabs></div>).container.innerHTML;
    expect(wrapped).toBe(plain);
  });

  it('inconsistent + defaultTab=display：仍只有提示与 canonical，绝不显示 display', () => {
    render(<LayoutReadTabs layout={STORED_INCONSISTENT} defaultTab="display">{canonical}</LayoutReadTabs>);
    expect(screen.getByText('policyLayout.inconsistent')).toBeDefined();
    expect(screen.getByTestId('canonical')).toBeDefined();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(displayRegion()).toBeNull();
  });

  it('inconsistent：显示提示与 canonical，没有标签与 display', () => {
    render(<LayoutReadTabs layout={STORED_INCONSISTENT}>{canonical}</LayoutReadTabs>);
    expect(screen.getByText('policyLayout.inconsistent')).toBeDefined();
    expect(screen.getByTestId('canonical')).toBeDefined();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(displayRegion()).toBeNull();
  });
});
