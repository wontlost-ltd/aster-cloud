'use client';

import { useLayoutEffect, useState, type RefObject } from 'react';

export interface FitViewportHeightOptions {
  /** 下限：视口再矮也不把工作区压到不可用。 */
  min: number;
  /** 上限：大屏上不无限拉高。 */
  max: number;
  /** 工作区下方需要留在视口内的高度（状态栏 + 间距）。 */
  reserve: number;
}

/**
 * 纯计算：元素顶边（文档坐标）到视口底部、扣掉下方预留后的可用高度，夹在 [min, max]。
 * 单独导出便于脱离 DOM 断言边界。
 */
export function fitViewportHeight(
  top: number,
  viewportHeight: number,
  { min, max, reserve }: FitViewportHeightOptions,
): number {
  return Math.min(max, Math.max(min, Math.round(viewportHeight - top - reserve)));
}

/**
 * 让元素高度恰好填满「首屏剩余高度」：按元素在文档中的实际顶边计算，而不是按固定的
 * 「100vh − 估算头部高度」。头部高度随副标题换行、错误横幅等变化，估算值曾让编辑器侧栏
 * 底边超出视口（907px / 887px），输入提示行被裁掉。
 *
 * <p>测量前返回 null，调用方继续用 CSS 兜底高度（SSR 与首帧一致，不产生 hydration 差异）。
 * deps 变化（如错误横幅出现）时重新测量。
 */
export function useFitViewportHeight(
  ref: RefObject<HTMLElement | null>,
  options: FitViewportHeightOptions,
  deps: readonly unknown[] = [],
): number | null {
  const [height, setHeight] = useState<number | null>(null);
  const { min, max, reserve } = options;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      // 文档坐标：与当前滚动位置无关，滚动后 resize 也算得一致。
      const top = el.getBoundingClientRect().top + window.scrollY;
      setHeight(fitViewportHeight(top, window.innerHeight, { min, max, reserve }));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
    // deps 由调用方传入，用于布局上方内容变化时重新测量。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, min, max, reserve, ...deps]);

  return height;
}
