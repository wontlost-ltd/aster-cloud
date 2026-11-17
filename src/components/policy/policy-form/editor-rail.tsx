'use client';

import {
  AlertTriangle,
  BookMarked,
  BookOpen,
  Boxes,
  LayoutTemplate,
  type LucideIcon,
  Settings,
  Sparkles,
  Tags,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/components/ui';
import type { StructuredAuthoringProps } from '@/lib/capabilities/types';
import type { SidePanelTab } from './side-panel';

interface EditorRailProps {
  activeTab?: SidePanelTab;
  open: boolean;
  errorCount: number;
  onSelect: (tab: SidePanelTab) => void;
  structuredAuthoring: StructuredAuthoringProps;
}

export function EditorRail({
  activeTab,
  open,
  errorCount,
  onSelect,
  structuredAuthoring,
}: EditorRailProps) {
  const t = useTranslations('policies.form');
  const tEditor = useTranslations('policyEditor');
  const tAliases = useTranslations('policies.form.aliases');
  const items: Array<{
    tab: SidePanelTab;
    label: string;
    icon: LucideIcon;
    badge?: number;
    danger?: boolean;
  }> = [
    { tab: 'settings', label: t('metaSection'), icon: Settings },
    { tab: 'aliases', label: tAliases('title'), icon: Tags },
    {
      tab: 'problems',
      label: t('decisionPreview'),
      icon: AlertTriangle,
      badge: errorCount > 0 ? errorCount : undefined,
      danger: errorCount > 0,
    },
    { tab: 'ai', label: t('sidePanelAI'), icon: Sparkles },
    { tab: 'syntax', label: t('sidePanelSyntax'), icon: BookOpen },
    { tab: 'templates', label: t('sidePanelTemplates'), icon: LayoutTemplate },
    ...(structuredAuthoring.allowed
      ? [
          { tab: 'model' as const, label: tEditor('tabModel'), icon: Boxes },
          { tab: 'vocabulary' as const, label: tEditor('tabVocabulary'), icon: BookMarked },
        ]
      : []),
  ];

  return (
    <nav
      className="hidden h-full w-12 shrink-0 flex-col items-center gap-1 rounded-xl border border-border bg-bg p-1.5 shadow-sm lg:flex"
      aria-label={t('sidePanelToggle')}
    >
      {items.map(({ tab, label, icon: Icon, badge, danger }) => {
        const active = open && activeTab === tab;
        return (
          <button
            key={tab}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={active}
            onClick={() => onSelect(tab)}
            className={cn(
              'relative inline-flex size-9 items-center justify-center rounded-lg transition-colors',
              'focus-visible:outline-none focus-visible:shadow-ring',
              active
                ? 'bg-primary-subtle text-primary-hover'
                : 'text-fg-muted hover:bg-bg-subtle hover:text-fg',
              danger && !active && 'text-danger hover:text-danger',
            )}
          >
            <Icon aria-hidden className="size-4" />
            {badge !== undefined && (
              <span
                className="absolute -right-1 -top-1 min-w-4 rounded-full bg-danger px-1 text-center text-[10px] font-semibold leading-4 text-danger-fg"
                aria-hidden
              >
                {badge > 9 ? '9+' : badge}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
