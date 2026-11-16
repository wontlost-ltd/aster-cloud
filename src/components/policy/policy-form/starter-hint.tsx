'use client';

/**
 * 新建策略的入门模板提示条：说明编辑器里是可直接修改的入门示例（标明其 CNL 语言），
 * 并提供「从空白开始」与关闭。只在入门模板未改动时由 PolicyForm 渲染。
 *
 * 文案本仓内联四语（与侧栏「模板」tab 的提示同一做法），避免为一条提示走 ui-messages 跨仓发版；
 * 未知界面语言回落英文。
 */

import { X } from 'lucide-react';
import { cn } from '@/components/ui';

interface StarterHintCopy {
  body: (locale: string) => string;
  startBlank: string;
  dismiss: string;
}

const COPY: Record<'en' | 'zh' | 'de' | 'hi', StarterHintCopy> = {
  en: {
    body: (locale) => `This new policy starts from a short ${locale} example. Edit it, or start from a blank editor.`,
    startBlank: 'Start blank',
    dismiss: 'Dismiss',
  },
  zh: {
    body: (locale) => `新策略已填入一段简短的 ${locale} 入门示例。可以直接修改，也可以从空白开始。`,
    startBlank: '从空白开始',
    dismiss: '关闭提示',
  },
  de: {
    body: (locale) => `Diese neue Richtlinie beginnt mit einem kurzen ${locale}-Beispiel. Bearbeiten Sie es oder beginnen Sie mit einem leeren Editor.`,
    startBlank: 'Leer beginnen',
    dismiss: 'Hinweis schließen',
  },
  hi: {
    body: (locale) => `यह नई नीति एक छोटे ${locale} उदाहरण से शुरू होती है। इसे संपादित करें या खाली संपादक से शुरू करें।`,
    startBlank: 'खाली से शुरू करें',
    dismiss: 'संकेत बंद करें',
  },
};

function copyFor(uiLocale: string): StarterHintCopy {
  const language = uiLocale.slice(0, 2) as keyof typeof COPY;
  return COPY[language] ?? COPY.en;
}

export interface StarterHintProps {
  uiLocale: string;
  /** 入门模板的 CNL 语言（规范标签，如 zh-CN）。 */
  cnlLocale: string;
  /** 清空编辑器从空白开始；手机只读视图不传（无法编辑）。 */
  onStartBlank?: () => void;
  onDismiss: () => void;
}

export function StarterHint({ uiLocale, cnlLocale, onStartBlank, onDismiss }: StarterHintProps) {
  const copy = copyFor(uiLocale);
  const buttonClass =
    'min-h-6 rounded border border-border bg-bg px-2 py-1 text-xs font-medium hover:bg-bg-muted focus-visible:outline-none focus-visible:shadow-ring';
  return (
    <div
      role="note"
      data-testid="policy-starter-hint"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-2 text-sm text-fg"
    >
      <span className="min-w-0 flex-1">{copy.body(cnlLocale.toUpperCase())}</span>
      {onStartBlank && (
        <button type="button" data-testid="policy-starter-blank" onClick={onStartBlank} className={buttonClass}>
          {copy.startBlank}
        </button>
      )}
      <button
        type="button"
        data-testid="policy-starter-dismiss"
        onClick={onDismiss}
        aria-label={copy.dismiss}
        title={copy.dismiss}
        className={cn(buttonClass, 'border-transparent bg-transparent p-1.5')}
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
