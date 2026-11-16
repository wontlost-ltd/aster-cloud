'use client';

/**
 * 行操作 / 卡片操作的下拉菜单（API 与 @aster-cloud/ui 的 Dropdown 相同，替换其导出）。
 *
 * 为什么不直接用设计系统版本（#786）：设计系统 0.3.2 的弹出层是 `absolute`，挂在触发按钮旁。放进带
 * `overflow-x-auto` 的容器（DataTable 的横向滚动外壳就是）时，CSS 规定另一轴随之变成 `auto`，弹出层被容器
 * 裁掉、只能在表格里纵向滚动才看得到——版本页「⋮ → Submit for approval」就这样看不见。z-index 无济于事，
 * 只有让弹出层脱离裁剪祖先的包含块才行。
 *
 * 做法：弹出层改为 `position: fixed`，按触发按钮的视口坐标放置（右对齐 / 左对齐、下方放不下时翻到上方、
 * 左右夹在视口内），打开时在绘制前定位，滚动（含任意内层容器）与窗口尺寸变化时重新定位。
 * 弹出层仍留在 DOM 原位（不用 portal）：Tab 顺序、读屏阅读顺序、点外部关闭的判定都与原组件一致。
 * 若某个祖先有 transform / filter（会成为 fixed 的包含块），定位后按实际落点反解平移与缩放；这种祖先若同时
 * overflow 非 visible 仍会裁掉弹出层（fixed 逃不出它），UI 审计的 popup-item-clipped 规则会报出来。
 *
 * 无障碍语义与原组件相同：诚实的 disclosure（触发按钮 aria-expanded，菜单项是普通按钮，按自然 Tab 顺序可达），
 * 不冒充 ARIA menu；Esc 与选中菜单项后焦点回到触发按钮。移动端菜单项用真实内边距撑到 44px 高，
 * 不靠伪元素点击区（相邻项的伪元素会互相重叠）。
 *
 * ★设计系统修好后（同样的 fixed 定位）删除本文件，index.ts 改回直接转出。
 */
import * as React from 'react';
import { cn, type DropdownItemProps, type DropdownProps } from '@aster-cloud/ui';

export type { DropdownItemProps, DropdownProps };

/** 弹出层与触发按钮的间距（px，对应原组件的 mt-2） */
const GAP = 8;
/** 弹出层离视口边缘的最小距离（px） */
const GUTTER = 8;

interface DropdownContextValue {
  close: () => void;
}

const DropdownContext = React.createContext<DropdownContextValue | null>(null);

/** 按触发按钮放置弹出层（视口坐标）；直接写 style，滚动时不触发重渲染。 */
function placePanel(trigger: HTMLElement, panel: HTMLElement, align: 'left' | 'right'): void {
  const r = trigger.getBoundingClientRect();
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = window.innerHeight;
  panel.style.maxHeight = `${Math.max(0, vh - 2 * GUTTER)}px`;
  const w = panel.offsetWidth;
  const h = panel.offsetHeight;
  const preferred = align === 'right' ? r.right - w : r.left;
  const left = Math.min(Math.max(GUTTER, preferred), Math.max(GUTTER, vw - GUTTER - w));
  const below = r.bottom + GAP;
  const above = r.top - GAP - h;
  // 下方放得下就放下方；放不下且上方放得下才翻到上方；两边都不够时贴着视口顶端（靠 maxHeight 内部滚动）
  const top = below + h <= vh - GUTTER ? below : above >= GUTTER ? above : Math.max(GUTTER, Math.min(below, vh - GUTTER - h));
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  // 祖先带 transform / filter 时 fixed 相对该祖先定位（可能平移也可能缩放）：实际落点与期望不符时，
  // 再放一个已知偏移的点量出缩放比例，按「平移 + 缩放」反解 CSS 坐标。旋转不处理（应用里没有）。
  const a = panel.getBoundingClientRect();
  if (Math.abs(a.left - left) <= 0.5 && Math.abs(a.top - top) <= 0.5) return;
  const PROBE = 100;
  panel.style.left = `${left + PROBE}px`;
  panel.style.top = `${top + PROBE}px`;
  const b = panel.getBoundingClientRect();
  const sx = (b.left - a.left) / PROBE || 1;
  const sy = (b.top - a.top) / PROBE || 1;
  panel.style.left = `${left + (left - a.left) / sx}px`;
  panel.style.top = `${top + (top - a.top) / sy}px`;
}

export function Dropdown({ trigger, children, align = 'right', className }: DropdownProps) {
  const [open, setOpen] = React.useState(false);
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);
  const panelRef = React.useRef<HTMLDivElement | null>(null);

  const triggerElement = React.useCallback(
    () => wrapperRef.current?.querySelector<HTMLElement>('[aria-expanded]') ?? null,
    [],
  );
  /** 键盘关闭或选中菜单项后把焦点还给触发按钮；点外部关闭时不抢焦点。 */
  const focusTrigger = React.useCallback(() => triggerElement()?.focus(), [triggerElement]);

  React.useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        focusTrigger();
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, focusTrigger]);

  // 绘制前定位，避免先在错误位置闪一下；任何滚动（capture 到内层容器）与尺寸变化都重新定位
  React.useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const t = triggerElement();
      const panel = panelRef.current;
      if (t && panel) placePanel(t, panel, align);
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, align, triggerElement]);

  const triggerEl = React.cloneElement(trigger, {
    onClick: (e: React.MouseEvent) => {
      trigger.props.onClick?.(e);
      setOpen((v) => !v);
    },
    'aria-expanded': open,
  });

  const close = React.useCallback(() => {
    setOpen(false);
    focusTrigger();
  }, [focusTrigger]);

  return (
    <div ref={wrapperRef} className="relative inline-block">
      {triggerEl}
      {open && (
        <DropdownContext.Provider value={{ close }}>
          <div
            ref={panelRef}
            data-dropdown-panel=""
            className={cn(
              'fixed z-50 w-48 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-md border border-border bg-bg py-1 text-left shadow-lg',
              'ring-1 ring-black/5 dark:ring-white/10',
              className,
            )}
          >
            {children}
          </div>
        </DropdownContext.Provider>
      )}
    </div>
  );
}

export function DropdownItem({ onSelect, variant = 'default', className, disabled, children, ...props }: DropdownItemProps) {
  const ctx = React.useContext(DropdownContext);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        ctx?.close();
        onSelect?.();
      }}
      className={cn(
        // 移动端真实高度 44px（py-3 + 20px 行高），伪元素点击区不再外扩，相邻项互不重叠（#774 / #786）
        'block w-full px-4 py-2 text-left text-sm transition-colors max-sm:py-3 max-sm:after:hidden',
        'focus:outline-none focus-visible:bg-bg-subtle',
        variant === 'danger' ? 'text-danger hover:bg-danger-subtle' : 'text-fg hover:bg-bg-subtle',
        disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
