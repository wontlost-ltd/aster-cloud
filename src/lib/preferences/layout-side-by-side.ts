/**
 * @module lib/preferences/layout-side-by-side
 *
 * 策略编辑器「并排视图」（显示排版窗格在 Monaco 左侧，ADR 0058 裁决 R11）的打开状态。
 *
 * <p>规则（ADR 0058 修订 1 的 A2）：
 * - 本次编辑里有显式状态时用它：作者点了「并排视图」开关，或套用了带排版的模板（#829 / #837，只开本次）；
 * - 否则，编辑器加载时带着一致的排版（活跃版本有排版、作者有结构化编写能力）→ 按浏览器偏好，缺省打开；
 *   作者曾显式关闭则保持关闭，直到他再次显式打开；
 * - 加载时没有排版 → 关闭，与引入本规则之前一致。
 *
 * <p>只有作者点开关才写偏好（按浏览器持久化，与 AI 行内补全开关同一机制）；套用模板不写，
 * 免得一次模板操作覆盖作者「默认关闭」的选择。
 */
'use client';

import { useCallback, useState } from 'react';
import { createBooleanPreference, useBooleanPreference } from './boolean-preference';

export const LAYOUT_SIDE_BY_SIDE_KEY = 'aster.editor.layoutSideBySide';

export const layoutSideBySidePreference = createBooleanPreference(LAYOUT_SIDE_BY_SIDE_KEY, true);

export interface LayoutSideBySide {
  /** 并排视图当前是否打开（窗格是否真的渲染还取决于排版与源码是否对应、是否移动端）。 */
  open: boolean;
  /** 作者显式切换：本次生效并写入偏好。 */
  setOpen: (open: boolean) => void;
  /** 程序打开（套用带排版的模板）：只在本次编辑生效，不写偏好。 */
  openForSession: () => void;
}

/**
 * @param openByDefault 编辑器加载时是否带着可显示的排版（有能力且活跃版本的排版与源码一致）。
 */
export function useLayoutSideBySide(openByDefault: boolean): LayoutSideBySide {
  const { value: preferred, setValue } = useBooleanPreference(layoutSideBySidePreference);
  const [session, setSession] = useState<boolean | null>(null);
  const setOpen = useCallback(
    (open: boolean) => {
      setSession(open);
      setValue(open);
    },
    [setValue],
  );
  const openForSession = useCallback(() => setSession(true), []);
  return { open: session ?? (openByDefault && preferred), setOpen, openForSession };
}
