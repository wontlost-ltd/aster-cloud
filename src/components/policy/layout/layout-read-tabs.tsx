'use client';

/**
 * 源码的只读视图：canonical 在前、显示排版在后（ADR 0058 §7.7 第 1 条，裁决 R15 / R16）。
 *
 * - `none`：只渲染 children，DOM 与引入 layout 之前一致；
 * - `ok`：两个标签，canonical 排第一且默认选中；display 只在切到次级标签后才渲染；
 * - `inconsistent`：children 加一条提示，不提供 display（绝不显示可能过期的排版）。
 *
 * children 是调用处原有的 canonical 渲染，原样保留。只读查看不设能力门（ADR §5.2）。
 */
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import type { StoredLayout } from '@/lib/policy-layout/types';
import { LayoutDisplayView } from './layout-display-view';

export interface LayoutReadTabsProps {
  layout: StoredLayout;
  children: ReactNode;
}

type TabId = 'canonical' | 'display';
const TABS: readonly TabId[] = ['canonical', 'display'];

export function LayoutReadTabs({ layout, children }: LayoutReadTabsProps) {
  if (layout.status === 'none') return <>{children}</>;
  if (layout.status === 'inconsistent') return <InconsistentNotice>{children}</InconsistentNotice>;
  return <OkTabs layout={layout}>{children}</OkTabs>;
}

function InconsistentNotice({ children }: { children: ReactNode }) {
  const t = useTranslations('policyLayout');
  return (
    <div className="space-y-2">
      <p
        data-layout-inconsistent=""
        className="rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-400/30 dark:bg-amber-950/30 dark:text-amber-100"
      >
        {t('inconsistent')}
      </p>
      {children}
    </div>
  );
}

function OkTabs({ layout, children }: { layout: Extract<StoredLayout, { status: 'ok' }>; children: ReactNode }) {
  const t = useTranslations('policyLayout');
  const [active, setActive] = useState<TabId>('canonical');
  const baseId = useId();
  const tabRefs = useRef<Record<TabId, HTMLButtonElement | null>>({ canonical: null, display: null });
  const tabId = (id: TabId) => `${baseId}-tab-${id}`;
  const panelId = (id: TabId) => `${baseId}-panel-${id}`;

  // WAI-ARIA 标签页的键盘约定：左右方向键循环，Home / End 到两端；选中即激活。
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.indexOf(active);
    const next = {
      ArrowRight: TABS[(index + 1) % TABS.length],
      ArrowLeft: TABS[(index - 1 + TABS.length) % TABS.length],
      Home: TABS[0],
      End: TABS[TABS.length - 1],
    }[event.key];
    if (!next) return;
    event.preventDefault();
    setActive(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="space-y-3">
      <div role="tablist" aria-label={t('tabsLabel')} className="flex flex-wrap gap-1 border-b border-border dark:border-gray-700">
        {TABS.map((id) => (
          <button
            key={id}
            ref={(el) => { tabRefs.current[id] = el; }}
            type="button"
            role="tab"
            id={tabId(id)}
            aria-selected={active === id}
            aria-controls={panelId(id)}
            tabIndex={active === id ? 0 : -1}
            onClick={() => setActive(id)}
            onKeyDown={onKeyDown}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              active === id
                ? 'border-primary text-primary'
                : 'border-transparent text-fg-muted hover:text-fg dark:text-fg-subtle dark:hover:text-gray-300'
            }`}
          >
            {t(id === 'canonical' ? 'tabCanonical' : 'tabDisplay')}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={panelId('canonical')} aria-labelledby={tabId('canonical')} hidden={active !== 'canonical'}>
        {children}
      </div>
      <div role="tabpanel" id={panelId('display')} aria-labelledby={tabId('display')} hidden={active !== 'display'}>
        {active === 'display' && (
          <div className="space-y-2">
            <p className="text-sm text-fg-muted dark:text-fg-subtle">{t('displayNote')}</p>
            <LayoutDisplayView layout={layout.layout} />
          </div>
        )}
      </div>
    </div>
  );
}
