// @vitest-environment jsdom
/**
 * 共享焦点陷阱（侧栏抽屉、词汇对话框共用）：首尾循环、焦点落在层外时拉回、无可聚焦元素时拦下 Tab、Esc 回调、滚动锁定。
 */
import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useFocusTrap } from '@/hooks/use-focus-trap';

function Trap({ onEscape, empty = false }: { onEscape: () => void; empty?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, onEscape);
  return (
    <>
      <button type="button">outside</button>
      <div ref={ref}>
        {empty ? <p>no controls</p> : (<><button type="button">first</button><button type="button">last</button></>)}
      </div>
    </>
  );
}

describe('useFocusTrap', () => {
  it('wraps Tab from last to first and Shift+Tab from first to last', () => {
    render(<Trap onEscape={vi.fn()} />);
    act(() => screen.getByText('last').focus());
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByText('first'));
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText('last'));
  });

  it('pulls focus back inside when it has escaped the container', () => {
    render(<Trap onEscape={vi.fn()} />);
    act(() => screen.getByText('outside').focus());
    const ev = fireEvent.keyDown(window, { key: 'Tab' });
    expect(ev).toBe(false); // preventDefault
    expect(document.activeElement).toBe(screen.getByText('first'));
  });

  it('swallows Tab when the container has nothing focusable', () => {
    render(<Trap onEscape={vi.fn()} empty />);
    expect(fireEvent.keyDown(window, { key: 'Tab' })).toBe(false);
  });

  it('calls onEscape and locks body scroll while active', () => {
    const onEscape = vi.fn();
    const { unmount } = render(<Trap onEscape={onEscape} />);
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
    unmount();
    expect(document.body.style.overflow).toBe('');
  });
});
