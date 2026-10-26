'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, AlertCircle, Loader2, XCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button, Card, CardBody, toast } from '@/components/ui';
import { normalizeRowErrors } from './bulk-result';
import { BulkRowErrors } from './bulk-row-errors';

interface BulkRollup {
  added?: number;
  reused?: number;
  modified?: number;
  skipped?: number;
  errorCount?: number;
}

interface BulkJobView {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  rowCount: number;
  processed: number;
  rollup: BulkRollup;
  errors: Array<Record<string, unknown>>;
  updatedAt: string;
  completedAt: string | null;
}

interface JobResponse {
  job: BulkJobView;
}

interface BulkJobProgressProps {
  jobId: string;
  /** Called when the job is no longer being tracked (dismiss / terminal + clear). */
  onClear: () => void;
  /** Called once the job reaches a terminal state so the parent can refresh. */
  onTerminal?: () => void;
}

const POLL_INTERVAL_MS = 1500;
const POLL_INTERVAL_MAX_MS = 6000;
const POLL_BACKOFF_FACTOR = 1.3;
// Backoff is wall-clock-since-start, not failure-driven: each successive
// non-terminal tick widens the gap up to POLL_INTERVAL_MAX_MS. This bounds
// load while keeping the first few updates snappy. A network error does
// NOT extend the interval beyond this curve.

/**
 * Polls /api/v1/domain-vocabularies/bulk/jobs/[id] until the job reaches a
 * terminal state. The polling interval backs off so a long-running job
 * doesn't hammer the API.
 *
 * Renders a card with a percentage bar + a rollup summary once complete.
 * Offers cancel during queued/running, and dismiss once terminal.
 */
export function BulkJobProgress({ jobId, onClear, onTerminal }: BulkJobProgressProps) {
  const t = useTranslations('domainVocabularies.jobProgress');
  const [job, setJob] = useState<BulkJobView | null>(null);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const onTerminalRef = useRef(onTerminal);
  // ref-latch：让稳定的轮询 effect 始终拿到最新 onTerminal 回调，故意在渲染期写 ref
  // eslint-disable-next-line react-hooks/refs
  onTerminalRef.current = onTerminal;
  const intervalRef = useRef<number>(POLL_INTERVAL_MS);
  const reachedTerminal = useRef(false);

  const fetchOnce = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/domain-vocabularies/bulk/jobs/${jobId}`, {
        credentials: 'same-origin',
      });
      if (!res.ok) {
        if (res.status === 404) {
          setError(t('notFound'));
          return null;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as JobResponse;
      return data.job;
    } catch (err) {
      console.error('[bulk-progress] fetch failed', err);
      setError(t('fetchFailed'));
      return null;
    }
  }, [jobId, t]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const next = await fetchOnce();
      if (cancelled) return;
      if (next) {
        setJob(next);
        if (isTerminal(next.status) && !reachedTerminal.current) {
          reachedTerminal.current = true;
          onTerminalRef.current?.();
        }
      }
      if (next && !isTerminal(next.status)) {
        intervalRef.current = Math.min(
          POLL_INTERVAL_MAX_MS,
          Math.floor(intervalRef.current * POLL_BACKOFF_FACTOR),
        );
        timer = setTimeout(tick, intervalRef.current);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [fetchOnce]);

  const handleCancel = async () => {
    if (!job || isTerminal(job.status)) return;
    setCancelling(true);
    try {
      const res = await fetch(`/api/v1/domain-vocabularies/bulk/jobs/${jobId}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success(t('cancelled'));
      const next = await fetchOnce();
      if (next) setJob(next);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('fetchFailed'));
    } finally {
      setCancelling(false);
    }
  };

  if (error) {
    return (
      <Card>
        <CardBody className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-danger">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            <span>{error}</span>
          </div>
          <Button variant="ghost" size="sm" onClick={onClear}>
            {t('dismiss')}
          </Button>
        </CardBody>
      </Card>
    );
  }

  if (!job) {
    return (
      <Card>
        <CardBody className="flex items-center gap-2 text-sm text-fg-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('loading')}
        </CardBody>
      </Card>
    );
  }

  const percent =
    job.rowCount > 0 ? Math.min(100, Math.round((job.processed / job.rowCount) * 100)) : 0;
  const rollup = job.rollup;
  const Icon = statusIcon(job.status);
  const tone = statusTone(job.status);
  const isFinished = isTerminal(job.status);

  return (
    <Card aria-live="polite" aria-busy={!isFinished}>
      <CardBody className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            {/* Icon 来自 statusIcon 返回的 lucide-react 模块级稳定引用，非渲染期新建组件，误报 */}
            {/* eslint-disable-next-line react-hooks/static-components */}
            <Icon
              className={`mt-0.5 h-5 w-5 ${tone}`}
              aria-hidden="true"
            />
            <div>
              <p className="text-sm font-semibold text-fg">
                {t(`status.${job.status}`)}
              </p>
              <p className="text-xs text-fg-muted">
                {t('progressSummary', {
                  processed: job.processed,
                  total: job.rowCount,
                })}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            {!isFinished ? (
              <Button
                variant="destructive"
                size="sm"
                onClick={handleCancel}
                disabled={cancelling}
              >
                {cancelling ? t('cancelling') : t('cancel')}
              </Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={onClear}>
                {t('dismiss')}
              </Button>
            )}
          </div>
        </div>

        <div
          className="h-2 w-full overflow-hidden rounded-full bg-bg-subtle"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div
            className={`h-full rounded-full transition-all duration-300 ${progressBarColor(job.status)}`}
            style={{ width: `${percent}%` }}
          />
        </div>

        {isFinished ? (
          <dl className="grid grid-cols-2 gap-2 text-xs text-fg-muted sm:grid-cols-5">
            <Stat label={t('rollup.added')} value={rollup.added ?? 0} />
            <Stat label={t('rollup.reused')} value={rollup.reused ?? 0} />
            <Stat label={t('rollup.modified')} value={rollup.modified ?? 0} />
            <Stat label={t('rollup.skipped')} value={rollup.skipped ?? 0} />
            <Stat
              label={t('rollup.errors')}
              value={rollup.errorCount ?? job.errors.length}
              danger={(rollup.errorCount ?? job.errors.length) > 0}
            />
          </dl>
        ) : null}

        {isFinished ? <BulkRowErrors errors={normalizeRowErrors(job.errors)} /> : null}
      </CardBody>
    </Card>
  );
}

function Stat({
  label,
  value,
  danger,
}: {
  label: string;
  value: number;
  danger?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <dt className="text-fg-subtle">{label}</dt>
      <dd className={`font-mono text-sm ${danger ? 'text-danger' : 'text-fg'}`}>
        {value}
      </dd>
    </div>
  );
}

function isTerminal(status: BulkJobView['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function statusIcon(status: BulkJobView['status']) {
  switch (status) {
    case 'completed':
      return CheckCircle2;
    case 'failed':
    case 'cancelled':
      return XCircle;
    default:
      return Loader2;
  }
}

function statusTone(status: BulkJobView['status']): string {
  switch (status) {
    case 'completed':
      return 'text-success';
    case 'failed':
      return 'text-danger';
    case 'cancelled':
      return 'text-fg-muted';
    case 'running':
      return 'text-primary animate-spin';
    default:
      return 'text-fg-muted animate-spin';
  }
}

function progressBarColor(status: BulkJobView['status']): string {
  switch (status) {
    case 'completed':
      return 'bg-success';
    case 'failed':
      return 'bg-danger';
    case 'cancelled':
      return 'bg-fg-subtle';
    default:
      return 'bg-primary';
  }
}
