// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { useRef } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import {
  fitViewportHeight,
  useFitViewportHeight,
} from '@/components/policy/policy-form/use-fit-viewport-height';

/**
 * F2：编辑器侧栏（工作台 iframe）底边曾超出视口（907px / 887px）。
 * 工作区高度改按元素实际顶边计算，状态栏也留在首屏内。
 */
const OPTS = { min: 560, max: 900, reserve: 64 };

describe('fitViewportHeight', () => {
  it('★线上场景：887px 视口、顶边 212px → 工作区底边不超出视口', () => {
    const h = fitViewportHeight(212, 887, OPTS);
    expect(h).toBe(611);
    expect(212 + h + OPTS.reserve).toBeLessThanOrEqual(887);
  });

  it('视口过矮时不低于下限，过高时不超过上限', () => {
    expect(fitViewportHeight(212, 600, OPTS)).toBe(560);
    expect(fitViewportHeight(212, 2000, OPTS)).toBe(900);
  });
});

function Probe({ top }: { top: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const h = useFitViewportHeight(ref, OPTS, [top]);
  return (
    <div
      ref={(el) => {
        ref.current = el;
        if (el) el.getBoundingClientRect = () => ({ top } as DOMRect);
      }}
      data-testid="box"
      data-h={h ?? 'none'}
    />
  );
}

describe('useFitViewportHeight', () => {
  afterEach(cleanup);

  it('挂载即测量，窗口 resize 后重新测量', () => {
    Object.defineProperty(window, 'innerHeight', { value: 887, configurable: true });
    render(<Probe top={212} />);
    expect(screen.getByTestId('box').getAttribute('data-h')).toBe('611');

    Object.defineProperty(window, 'innerHeight', { value: 1087, configurable: true });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(screen.getByTestId('box').getAttribute('data-h')).toBe('811');
  });

  it('deps 变化（如上方出现错误横幅推移顶边）时重新测量', () => {
    Object.defineProperty(window, 'innerHeight', { value: 887, configurable: true });
    const { rerender } = render(<Probe top={212} />);
    rerender(<Probe top={260} />);
    expect(screen.getByTestId('box').getAttribute('data-h')).toBe('563');
  });
});
