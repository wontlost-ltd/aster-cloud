'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Sparkles,
  WifiOff,
} from 'lucide-react';
import { cn } from '@/components/ui';
import { isAssistantLauncherVisible, useAssistant } from '@/components/assistant/assistant-context';
import type { CompileDiagnostic, CompileState } from './use-compile';

/**
 * Footer status bar — a one-line summary of the editor state plus
 * always-visible shortcut hints. Lives at the bottom of the IDE
 * layout, matching the convention of VS Code / JetBrains.
 *
 * Information density is deliberate: line count, CNL locale,
 * compile state, save state, and the two most-used shortcut hints.
 * The compile chip is itself a status signal — Loader during
 * pending, ✓ on success, AlertCircle on errors with a count.
 */

export interface StatusBarProps {
  /** Editor body — used to count lines. */
  content: string;
  /** CNL locale label, e.g. 'en' / 'zh' / 'de'. */
  cnlLocale: string;
  /** True when the form has unsaved changes. */
  isDirty: boolean;
  /** Epoch ms of the last localStorage autosave; 0 if none. */
  lastSavedAt: number;
  /** Real-time compile machine state. */
  compileState?: CompileState;
  /** Diagnostics from the most recent compile, for the counts. */
  compileDiagnostics?: CompileDiagnostic[];
  /** Non-empty when the compile request itself failed (5xx, network). */
  compileTransportError?: string;
  /** Click the compile chip → open decision panel. */
  onCompileChipClick?: () => void;
  /**
   * AI 行内补全开关（与设置页共用同一份本地偏好）。不传则不显示。
   * hydrating 期间禁用：此时 enabled 还是默认值，点下去会覆盖用户真实设置。
   */
  aiCompletion?: {
    enabled: boolean;
    hydrating: boolean;
    onToggle: () => void;
  };
}

export function StatusBar({
  content,
  cnlLocale,
  isDirty,
  lastSavedAt,
  compileState,
  compileDiagnostics,
  compileTransportError,
  onCompileChipClick,
  aiCompletion,
}: StatusBarProps) {
  const t = useTranslations('policies.form');
  const lineCount = content.length === 0 ? 0 : content.split('\n').length;
  const ago = useTimeAgo(lastSavedAt);
  // 悬浮助手按钮（fixed bottom-4 right-4，48px，距视口右缘共 4rem）显示时会盖住状态栏
  // 右端的快捷键提示。状态栏所在容器贴近视口右缘，故按钮显示时右外边距放到 5rem 让开它
  const reserveLauncher = isAssistantLauncherVisible(useAssistant());

  return (
    <footer
      data-testid="policy-status-bar"
      className={cn(
        'ml-4 sm:ml-6',
        reserveLauncher ? 'mr-20' : 'mr-4 sm:mr-6',
        'flex items-center gap-3 rounded-md border border-border bg-bg-subtle px-3 py-1.5 text-xs text-fg-muted',
      )}
      role="status"
      aria-live="polite"
    >
      <span>{t('statusLines', { count: lineCount })}</span>
      <Separator />
      <span>{t('statusLocale', { locale: cnlLocale.toUpperCase() })}</span>

      {compileState && compileState !== 'idle' && (
        <>
          <Separator />
          {onCompileChipClick ? (
            <button
              type="button"
              onClick={onCompileChipClick}
              className="rounded px-1 -mx-1 hover:bg-bg-muted focus-visible:outline-none focus-visible:shadow-ring"
            >
              <CompileChip
                state={compileState}
                diagnostics={compileDiagnostics ?? []}
                transportError={compileTransportError}
              />
            </button>
          ) : (
            <CompileChip
              state={compileState}
              diagnostics={compileDiagnostics ?? []}
              transportError={compileTransportError}
            />
          )}
        </>
      )}

      <Separator />
      {isDirty ? (
        <span className="text-warning">{t('statusUnsaved')}</span>
      ) : lastSavedAt > 0 ? (
        <span>{t('statusSavedAgo', { time: ago })}</span>
      ) : null}

      {/* Right-aligned shortcut hints */}
      <span className="ml-auto flex items-center gap-3">
        {aiCompletion && (
          <>
            <button
              type="button"
              role="switch"
              aria-checked={aiCompletion.enabled}
              aria-label={t('statusAiCompletionLabel')}
              title={t('statusAiCompletionHint')}
              disabled={aiCompletion.hydrating}
              onClick={aiCompletion.onToggle}
              data-testid="status-ai-completion-toggle"
              className={cn(
                'inline-flex items-center gap-1 rounded px-1 -mx-1 hover:bg-bg-muted',
                'focus-visible:outline-none focus-visible:shadow-ring disabled:opacity-50',
                aiCompletion.enabled ? 'text-fg' : 'text-fg-subtle',
              )}
            >
              <Sparkles className="size-3" aria-hidden />
              {aiCompletion.enabled ? t('statusAiCompletionOn') : t('statusAiCompletionOff')}
            </button>
            <Separator />
          </>
        )}
        <ShortcutHint label={t('statusSaveHint')} />
        <Separator />
        <ShortcutHint label={t('statusPaletteHint')} />
      </span>
    </footer>
  );
}

function CompileChip({
  state,
  diagnostics,
  transportError,
}: {
  state: CompileState;
  diagnostics: CompileDiagnostic[];
  transportError?: string;
}) {
  const t = useTranslations('policies.form');
  if (state === 'pending') {
    return (
      <span className="inline-flex items-center gap-1">
        <Loader2 aria-hidden className="size-3 animate-spin" />
        {t('compileChecking')}
      </span>
    );
  }
  if (state === 'error' && transportError) {
    return (
      <span className="inline-flex items-center gap-1 text-danger">
        <WifiOff aria-hidden className="size-3" />
        {t('compileTransportError')}
      </span>
    );
  }
  // ok
  const errorCount = diagnostics.filter((d) => d.severity === 'error').length;
  const warningCount = diagnostics.filter(
    (d) => d.severity === 'warning',
  ).length;
  if (errorCount > 0) {
    return (
      <span className={cn('inline-flex items-center gap-1 text-danger')}>
        <AlertCircle aria-hidden className="size-3" />
        {t('compileErrors', { count: errorCount })}
      </span>
    );
  }
  if (warningCount > 0) {
    return (
      <span className="inline-flex items-center gap-1 text-warning">
        <AlertTriangle aria-hidden className="size-3" />
        {t('compileWarnings', { count: warningCount })}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-success-fg">
      <CheckCircle2 aria-hidden className="size-3" />
      {t('compileOk')}
    </span>
  );
}

function Separator() {
  return (
    <span aria-hidden className="text-fg-subtle">
      ·
    </span>
  );
}

function ShortcutHint({ label }: { label: string }) {
  return <span className="font-mono text-[11px]">{label}</span>;
}

/**
 * Minimal "n seconds ago" formatter. We deliberately don't pull in
 * a date-fns dep for one line of relative time. Re-render every
 * 30s so the value doesn't lie for long.
 */
function useTimeAgo(epochMs: number): string {
  // Initialize to 0 (not Date.now()) so SSR and the first client
  // render produce the same DOM — bumping the value happens inside
  // useEffect, which never runs server-side.
  const [now, setNow] = useState(0);
  useEffect(() => {
    // SSR 稳定初值 0，hydration 后在 effect 内填入真实时间并每 30s 刷新——
    // 从外部时钟同步，非渲染循环。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
    if (!epochMs) return;
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, [epochMs]);

  if (!epochMs || !now) return '';
  const diffSec = Math.max(0, Math.round((now - epochMs) / 1000));
  if (diffSec < 5) return 'now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const min = Math.round(diffSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  return `${hr}h ago`;
}
