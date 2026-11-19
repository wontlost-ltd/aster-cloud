/*
 * 只读源码视图：canonical 在前、显示排版在后（ADR 0058 §7.7 第 1 条，计划 T7）。
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

  it('inconsistent：显示提示与 canonical，没有标签与 display', () => {
    render(<LayoutReadTabs layout={STORED_INCONSISTENT}>{canonical}</LayoutReadTabs>);
    expect(screen.getByText('policyLayout.inconsistent')).toBeDefined();
    expect(screen.getByTestId('canonical')).toBeDefined();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(displayRegion()).toBeNull();
  });
});
