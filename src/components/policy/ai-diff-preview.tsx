'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { DiffEditor } from '@monaco-editor/react';
import { useTheme } from 'next-themes';

interface AIDiffPreviewProps {
  original: string;
  generated: string;
  onAccept: () => void;
  onReject: () => void;
}

export function AIDiffPreview({ original, generated, onAccept, onReject }: AIDiffPreviewProps) {
  const t = useTranslations('ai');
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const handleAccept = useCallback(() => {
    onAccept();
  }, [onAccept]);

  const handleReject = useCallback(() => {
    onReject();
  }, [onReject]);

  return (
    <div className="rounded-lg border border-border dark:border-gray-700 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-bg-subtle dark:bg-gray-800/50 border-b border-border dark:border-gray-700">
        <span className="text-xs font-medium text-fg-muted dark:text-fg-subtle">
          {t('diffPreview')}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleAccept}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-fg hover:bg-primary-hover"
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
            {t('acceptDiff')}
          </button>
          <button
            type="button"
            onClick={handleReject}
            className="inline-flex items-center gap-1 rounded-md border border-border-strong dark:border-gray-600 bg-bg dark:bg-gray-800 px-2.5 py-1 text-xs font-medium text-fg dark:text-gray-300 hover:bg-bg-subtle dark:hover:bg-gray-700"
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
            {t('rejectDiff')}
          </button>
        </div>
      </div>
      {/*
        Inline diff (renderSideBySide: false) is mandatory here.
        The AI Assistant panel lives inside the policy form's
        right rail at w-[28rem] (~448px). Side-by-side mode adds
        a second column plus a gutter — Monaco's minimum widths
        push the diff editor past 448px and the rail overflows
        into the editor column, breaking the page layout.
        Inline mode shows additions / deletions stacked in a
        single column and fits the rail cleanly.
       */}
      <DiffEditor
        height="300px"
        language="aster-cnl"
        original={original}
        modified={generated}
        theme={isDark ? 'vs-dark' : 'vs'}
        options={{
          readOnly: true,
          renderSideBySide: false,
          minimap: { enabled: false },
          fontSize: 13,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          renderOverviewRuler: false,
        }}
      />
    </div>
  );
}
