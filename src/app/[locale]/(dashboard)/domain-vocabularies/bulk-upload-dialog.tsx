'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertCircle, FileText, Upload, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  Alert,
  AlertDescription,
  Button,
  Label,
  Textarea,
  toast,
} from '@/components/ui';
import {
  normalizeRowErrors,
  summarizeBulkOutcome,
  type BulkOutcomeSummary,
  type BulkRollupView,
  type BulkRowErrorView,
} from './bulk-result';
import { BulkRowErrors, BulkSkippedReasons, skippedReasonTexts } from './bulk-row-errors';
import { parseBulkInput, parseFindingText, type ParseOutcome } from './bulk-parse';
import { useFocusTrap } from './use-focus-trap';
import { useVocabularyErrors } from './use-vocabulary-errors';

interface BulkUploadDialogProps {
  isOpen: boolean;
  /** True when the caller's plan supports async (Pro+); else only sync. */
  bulkAsyncAllowed: boolean;
  onClose: () => void;
  onEnqueued: (jobId: string) => void;
  /** 同步导入至少落了一行时回调，父组件据此刷新列表。 */
  onImported?: () => void;
}

/** 同步导入的响应体（/bulk）。 */
interface SyncBulkResponse {
  rowCount?: number;
  rollup?: BulkRollupView;
  errors?: unknown[];
}

interface SyncResultView {
  summary: BulkOutcomeSummary;
  errors: BulkRowErrorView[];
}

const SYNC_LIMIT = 500;
const ASYNC_LIMIT = 10_000;
const PREVIEW_ROWS = 20;

/**
 * Multi-row upload dialog.
 *
 * The user pastes either CSV (header row required) or a JSON array of term
 * objects. Both encodings parse to the same {@link ParsedRow} shape. We
 * preview the first {@link PREVIEW_ROWS} rows, surface validation errors
 * inline, and let the user pick sync (≤500) or async (≤10k) submission
 * before sending the payload.
 */
export function BulkUploadDialog({
  isOpen,
  bulkAsyncAllowed,
  onClose,
  onEnqueued,
  onImported,
}: BulkUploadDialogProps) {
  const t = useTranslations('domainVocabularies.bulk');
  const vocabularyErrors = useVocabularyErrors();
  const titleId = useId();
  const formRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [raw, setRaw] = useState('');
  const [mode, setMode] = useState<'sync' | 'async'>('sync');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [syncResult, setSyncResult] = useState<SyncResultView | null>(null);
  // The idempotency key is fixed per dialog session so a double-click /
  // network retry collapses to one job rather than creating duplicates.
  const idempotencyKeyRef = useRef<string>('');

  useEffect(() => {
    if (!isOpen) return;
    // 打开时重置表单状态（防上次编辑泄漏），故意在 effect 内 set
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRaw('');
    setMode('sync');
    setSubmitError('');
    setSyncResult(null);
    setSubmitting(false);
    idempotencyKeyRef.current = crypto.randomUUID();
    // Drop focus into the file picker button after first paint so a
    // keyboard user can immediately Tab into the textarea.
    const id = window.requestAnimationFrame(() => {
      fileInputRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(id);
  }, [isOpen]);

  const onEscape = useCallback(() => {
    if (!submitting) onClose();
  }, [submitting, onClose]);
  useFocusTrap(formRef, isOpen, onEscape);

  const outcome = useMemo<ParseOutcome>(() => parseBulkInput(raw), [raw]);
  const preview = outcome.rows.slice(0, PREVIEW_ROWS);
  const totalRows = outcome.rows.length;
  const overSync = totalRows > SYNC_LIMIT;
  const overAsync = totalRows > ASYNC_LIMIT;
  const canSubmit =
    !submitting &&
    !syncResult &&
    totalRows > 0 &&
    outcome.errors.length === 0 &&
    !overAsync &&
    (mode === 'async' || !overSync);

  // If the chosen mode doesn't fit, auto-pick the larger one when allowed.
  useEffect(() => {
    if (overSync && bulkAsyncAllowed && mode === 'sync') {
      // 行数超同步上限时自动切到 async（条件收敛不会循环），故意在 effect 内 set
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMode('async');
    }
  }, [overSync, bulkAsyncAllowed, mode]);

  if (!isOpen) return null;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      const url =
        mode === 'sync'
          ? '/api/v1/domain-vocabularies/bulk'
          : '/api/v1/domain-vocabularies/bulk/jobs';
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKeyRef.current,
        },
        credentials: 'same-origin',
        body: JSON.stringify({ terms: outcome.rows }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { message?: string; code?: string };
        };
        // 整批被拒（行数超限、空批等）：按错误码本地化，不显示服务端原文（#634）
        throw new Error(vocabularyErrors.envelope(body.error?.code, body.error?.message, t('errorGeneric')));
      }
      if (mode === 'async') {
        const data = (await res.json()) as { jobId?: string };
        toast.success(t('asyncEnqueued'));
        if (data.jobId) onEnqueued(data.jobId);
        onClose();
        return;
      }
      handleSyncResult((await res.json()) as SyncBulkResponse);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('errorGeneric');
      setSubmitError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  // 同步结果以服务端 rollup 为准（#607）：全部成功才关窗；有失败行时留在弹窗里列出原因。
  const handleSyncResult = (data: SyncBulkResponse) => {
    const summary = summarizeBulkOutcome(data.rollup, data.errors, data.rowCount);
    if (summary.imported > 0) onImported?.();
    if (summary.tone === 'success') {
      toast.success(t('syncCompleted', { count: summary.imported }));
      onClose();
      return;
    }
    // 总数取服务端 rowCount，与「已导入 + 未导入」同一口径（#629）；未导入的按原因分组附在后面（#636），
    // 避免把「已在你的词汇中」误读成导入失败或 reused。
    const counts = { imported: summary.imported, failed: summary.failed, total: summary.total };
    const errors = normalizeRowErrors(data.errors);
    const reasons = skippedReasonTexts(errors, summary.failed, t).join(', ');
    const headline = t(summary.tone === 'partial' ? 'syncPartial' : 'syncNoneImported', counts);
    const message = reasons ? `${headline} (${reasons})` : headline;
    if (summary.tone === 'partial') toast.warning(message);
    else toast.error(message);
    setSyncResult({ summary, errors });
  };

  const handleFile = async (file: File) => {
    try {
      const text = await file.text();
      setRaw(text);
    } catch {
      setSubmitError(t('errorReadFile'));
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="absolute inset-0 bg-black/40"
        onClick={() => {
          if (!submitting) onClose();
        }}
      />

      <div
        ref={formRef}
        className="relative z-10 flex max-h-[90vh] w-full max-w-3xl flex-col rounded-lg bg-bg shadow-xl"
      >
        <header className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 id={titleId} className="font-display text-lg font-semibold text-fg">
            {t('title')}
          </h2>
          <button
            type="button"
            onClick={() => {
              if (!submitting) onClose();
            }}
            aria-label={t('cancel')}
            className="rounded p-1 text-fg-muted hover:bg-bg-subtle hover:text-fg focus:outline-none focus-visible:shadow-ring"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <div className="overflow-y-auto px-6 py-4">
          <p className="text-sm text-fg-muted">{t('description')}</p>

          <div className="mt-4 flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.json,text/csv,application/json"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="mr-1.5 h-4 w-4" aria-hidden="true" />
              {t('chooseFile')}
            </Button>
            <span className="text-xs text-fg-subtle">{t('orPaste')}</span>
          </div>

          <div className="mt-3">
            <Label htmlFor="bulk-raw">{t('rawLabel')}</Label>
            <Textarea
              id="bulk-raw"
              rows={6}
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={t('placeholder')}
              className="font-mono text-xs"
            />
          </div>

          {totalRows > 0 ? (
            <div className="mt-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-fg">
                  {t('previewTitle', { shown: preview.length, total: totalRows })}
                </h3>
                <span className="text-xs text-fg-subtle">
                  {t(overAsync ? 'tooManyAsync' : overSync ? 'tooManySync' : 'rowsValid', {
                    syncLimit: SYNC_LIMIT,
                    asyncLimit: ASYNC_LIMIT,
                  })}
                </span>
              </div>
              <div className="mt-2 overflow-x-auto rounded-md border border-border">
                <table className="min-w-full text-sm">
                  <thead className="bg-bg-subtle text-xs uppercase text-fg-muted">
                    <tr>
                      <th className="px-3 py-2 text-left">#</th>
                      <th className="px-3 py-2 text-left">{t('col.kind')}</th>
                      <th className="px-3 py-2 text-left">{t('col.canonical')}</th>
                      <th className="px-3 py-2 text-left">{t('col.localized')}</th>
                      <th className="px-3 py-2 text-left">{t('col.domain')}</th>
                      <th className="px-3 py-2 text-left">{t('col.locale')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {preview.map((row, i) => (
                      <tr key={i}>
                        <td className="px-3 py-2 font-mono text-xs text-fg-subtle">
                          {i + 1}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">{row.kind}</td>
                        <td className="px-3 py-2 font-mono text-xs">{row.canonical}</td>
                        <td className="px-3 py-2">{row.localized}</td>
                        <td className="px-3 py-2 text-fg-muted">{row.domain}</td>
                        <td className="px-3 py-2 text-fg-muted">{row.locale}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {outcome.errors.length > 0 ? (
            <div className="mt-4">
              <Alert variant="danger">
                <AlertCircle className="h-4 w-4" aria-hidden="true" />
                <AlertDescription>
                  <p className="font-medium">{t('parseErrorsTitle')}</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
                    {outcome.errors.slice(0, 5).map((err, i) => (
                      <li key={i}>
                        {parseFindingText(err, t)}
                      </li>
                    ))}
                    {outcome.errors.length > 5 ? (
                      <li>{t('moreErrors', { n: outcome.errors.length - 5 })}</li>
                    ) : null}
                  </ul>
                </AlertDescription>
              </Alert>
            </div>
          ) : null}

          {totalRows > 0 ? (
            <fieldset className="mt-4 grid gap-2 sm:grid-cols-2">
              <legend className="text-xs font-medium text-fg-muted">
                {t('modeLabel')}
              </legend>
              <ModeOption
                id="bulk-mode-sync"
                checked={mode === 'sync'}
                onChange={() => setMode('sync')}
                disabled={overSync}
                title={t('syncTitle')}
                description={t('syncDescription', { limit: SYNC_LIMIT })}
              />
              <ModeOption
                id="bulk-mode-async"
                checked={mode === 'async'}
                onChange={() => setMode('async')}
                disabled={!bulkAsyncAllowed || overAsync}
                title={t('asyncTitle')}
                description={
                  bulkAsyncAllowed
                    ? t('asyncDescription', { limit: ASYNC_LIMIT })
                    : t('asyncProRequired')
                }
              />
            </fieldset>
          ) : null}

          {syncResult ? (
            <div className="mt-4">
              <Alert variant={syncResult.summary.tone === 'partial' ? 'warning' : 'danger'}>
                <AlertCircle className="h-4 w-4" aria-hidden="true" />
                <AlertDescription>
                  <p className="mb-2 font-medium">
                    {t(syncResult.summary.tone === 'partial' ? 'syncPartial' : 'syncNoneImported', {
                      imported: syncResult.summary.imported,
                      failed: syncResult.summary.failed,
                      total: totalRows,
                    })}
                  </p>
                  <div className="space-y-3">
                    <BulkSkippedReasons errors={syncResult.errors} skipped={syncResult.summary.failed} />
                    <BulkRowErrors errors={syncResult.errors} />
                  </div>
                </AlertDescription>
              </Alert>
            </div>
          ) : null}

          {submitError ? (
            <div className="mt-4">
              <Alert variant="danger">
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            </div>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              if (!submitting) onClose();
            }}
            disabled={submitting}
          >
            {t('cancel')}
          </Button>
          {syncResult ? (
            <Button type="button" variant="primary" onClick={onClose}>
              {t('done')}
            </Button>
          ) : (
            <Button
              type="button"
              variant="primary"
              disabled={!canSubmit}
              onClick={handleSubmit}
            >
              {submitting ? t('submitting') : t('submit')}
            </Button>
          )}
        </footer>
      </div>
    </div>
  );
}

interface ModeOptionProps {
  id: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  title: string;
  description: string;
}

function ModeOption({
  id,
  checked,
  onChange,
  disabled,
  title,
  description,
}: ModeOptionProps) {
  return (
    <label
      htmlFor={id}
      className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm ${
        disabled
          ? 'cursor-not-allowed border-border bg-bg-subtle text-fg-subtle'
          : checked
            ? 'border-primary bg-primary-subtle text-fg'
            : 'border-border bg-bg text-fg hover:bg-bg-subtle'
      }`}
    >
      <input
        id={id}
        type="radio"
        className="mt-1 h-4 w-4"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
      />
      <span className="flex flex-col">
        <span className="flex items-center gap-1 font-medium">
          <FileText className="h-3.5 w-3.5" aria-hidden="true" /> {title}
        </span>
        <span className="text-xs text-fg-muted">{description}</span>
      </span>
    </label>
  );
}
