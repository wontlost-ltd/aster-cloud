import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Dropdown, DropdownItem, DropdownSeparator } from '@/components/ui';

/**
 * 下拉菜单（#786）：弹出层 fixed 定位，不再被 overflow 祖先（DataTable 的横向滚动外壳）裁掉。
 * jsdom 没有布局，这里用桩出的 getBoundingClientRect / offset 尺寸验证定位算法；真实浏览器里的裁剪由
 * Playwright 本地栈用例（policy-row-menus-786）与 UI 审计的弹出层裁剪规则验证。
 */

const VW = 390;
const VH = 844;

function rect(x: number, y: number, w: number, h: number): DOMRect {
  return { x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON: () => ({}) } as DOMRect;
}

/** 触发按钮放在 (x, y)，面板 192×(items×36+8)；面板的实际落点按其 style.left/top 计算（无 transform 祖先） */
function stubLayout(trigger: DOMRect, panelH = 80) {
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: VW });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VH });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute('data-dropdown-panel')) {
      return rect(parseFloat(this.style.left) || 0, parseFloat(this.style.top) || 0, 192, panelH);
    }
    if (this.hasAttribute('aria-expanded')) return trigger;
    return rect(0, 0, 0, 0);
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-dropdown-panel') ? 192 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-dropdown-panel') ? panelH : 0;
  });
}

function renderMenu(onSelect = vi.fn(), align?: 'left' | 'right') {
  render(
    <div>
      <Dropdown align={align} trigger={<button type="button" aria-label="Actions">⋮</button>}>
        <DropdownItem onSelect={onSelect}>Submit for approval</DropdownItem>
        <DropdownSeparator />
        <DropdownItem variant="danger">Archive</DropdownItem>
      </Dropdown>
      <button type="button">outside</button>
    </div>,
  );
  return onSelect;
}

const open = () => fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
const panel = () => document.querySelector<HTMLElement>('[data-dropdown-panel]');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Dropdown (fixed popover)', () => {
  it('opens as a fixed-position panel so overflow ancestors cannot clip it', () => {
    stubLayout(rect(300, 100, 32, 32));
    renderMenu();
    open();
    expect(screen.getByRole('button', { name: 'Actions' }).getAttribute('aria-expanded')).toBe('true');
    expect(panel()?.className).toMatch(/\bfixed\b/);
    expect(panel()?.className).not.toMatch(/\babsolute\b/);
  });

  it('right-aligns under the trigger by default', () => {
    stubLayout(rect(300, 100, 32, 32));
    renderMenu();
    open();
    expect(panel()?.style.left).toBe(`${332 - 192}px`);
    expect(panel()?.style.top).toBe(`${132 + 8}px`);
  });

  it('left align starts at the trigger and is clamped inside the viewport', () => {
    stubLayout(rect(300, 100, 32, 32));
    renderMenu(vi.fn(), 'left');
    open();
    // 300 + 192 超出 390，夹回 390 - 8 - 192
    expect(panel()?.style.left).toBe(`${VW - 8 - 192}px`);
  });

  it('flips above the trigger when there is no room below (last table row near the bottom)', () => {
    stubLayout(rect(300, 800, 32, 32));
    renderMenu();
    open();
    expect(panel()?.style.top).toBe(`${800 - 8 - 80}px`);
  });

  it('corrects for a transformed ancestor that becomes the fixed containing block', () => {
    stubLayout(rect(300, 100, 32, 32));
    const real = HTMLElement.prototype.getBoundingClientRect as unknown as { getMockImplementation(): (this: HTMLElement) => DOMRect };
    const base = real.getMockImplementation();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const r = base.call(this);
      // 祖先带 transform 时实际落点整体偏移 (+20, +50)
      return this.hasAttribute('data-dropdown-panel') ? rect(r.left + 20, r.top + 50, r.width, r.height) : r;
    });
    renderMenu();
    open();
    expect(panel()?.style.left).toBe(`${140 - 20}px`);
    expect(panel()?.style.top).toBe(`${140 - 50}px`);
  });

  it('repositions on scroll inside any container (capture)', () => {
    const trigger = rect(300, 100, 32, 32);
    stubLayout(trigger);
    renderMenu();
    open();
    Object.assign(trigger, { top: 60, y: 60, bottom: 92 });
    fireEvent.scroll(document.body);
    expect(panel()?.style.top).toBe(`${92 + 8}px`);
  });

  it('selecting an item closes the menu, returns focus to the trigger and fires onSelect', () => {
    stubLayout(rect(300, 100, 32, 32));
    const onSelect = renderMenu();
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Submit for approval' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Actions' }));
  });

  it('Escape closes and restores focus; outside mousedown closes without stealing focus', () => {
    stubLayout(rect(300, 100, 32, 32));
    renderMenu();
    open();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Actions' }));
    open();
    const outside = screen.getByRole('button', { name: 'outside' });
    outside.focus();
    fireEvent.mouseDown(outside);
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it('items stay in DOM order right after the trigger (natural Tab order, no portal)', () => {
    stubLayout(rect(300, 100, 32, 32));
    renderMenu();
    open();
    const trigger = screen.getByRole('button', { name: 'Actions' });
    expect(trigger.parentElement?.contains(panel())).toBe(true);
  });

  it('mobile: items get a real 44px height instead of an overlapping pseudo-element hit area', () => {
    stubLayout(rect(300, 100, 32, 32));
    renderMenu();
    open();
    const item = screen.getByRole('button', { name: 'Submit for approval' });
    expect(item.className).toMatch(/max-sm:py-3/);
    expect(item.className).toMatch(/max-sm:after:hidden/);
  });
});
