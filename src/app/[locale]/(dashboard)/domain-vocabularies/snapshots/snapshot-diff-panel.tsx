'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Equal, Loader2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
} from '@/components/ui';
import { useFocusTrap } from '../use-focus-trap';

interface DiffSnapshotMeta {
  id: string;
  domain: string;
  locale: string;
  version: number;
  termCount: number;
  archived: boolean;
}

interface DiffTermEntry {
  termId: string;
  kind: string;
  canonical: string;
  localized: string;
  parentCanonical: string | null;
  aliases: string[];
  description: string | null;
}

interface DiffResponse {
  snapshot: DiffSnapshotMeta;
  terms: DiffTermEntry[];
  removedTerms: DiffTermEntry[];
  currentTermIds: string[];
  addedIds: string[];
  removedIds: string[];
  unchangedIds: string[];
}

interface SnapshotDiffPanelProps {
  snapshot: DiffSnapshotMeta;
  onClose: () => void;
  onRollback: () => void;
}

type Bucket = 'all' | 'added' | 'removed' | 'unchanged';

/**
 * Side panel that fetches a snapshot's resolved terms + set comparison and
 * renders an add/remove/unchanged grouping. Drives the F8 rollback flow.
 *
 * Lazily-loaded so the snapshots list page can ship without paying for
 * detail roundtrips up-front; the panel manages its own loading state.
 */
export function SnapshotDiffPanel({
  snapshot,
  onClose,
  onRollback,
}: SnapshotDiffPanelProps) {
  const t = useTranslations('domainVocabularies.snapshotsView.diff');
  const tKinds = useTranslations('domainVocabularies.kinds');
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);

  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [error, setError] = useState('');
  const [bucket, setBucket] = useState<Bucket>('all');

  const handleEscape = useCallback(() => onClose(), [onClose]);
  useFocusTrap(panelRef, true, handleEscape);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/v1/domain-vocabularies/snapshots/${snapshot.id}`,
          { credentials: 'same-origin' },
        );
        if (!res.ok) {
          // 不显示服务端原文（#634）：加载失败只有一种用户可理解的说法
          throw new Error(t('loadFailed'));
        }
        const data = (await res.json()) as DiffResponse;
        if (!cancelled) setDiff(data);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t('loadFailed'));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [snapshot.id, t]);

  const addedSet = diff ? new Set(diff.addedIds) : new Set<string>();
  const removedSet = diff ? new Set(diff.removedIds) : new Set<string>();
  const visibleTerms = (() => {
    if (!diff) return [];
    switch (bucket) {
      case 'added':
        return diff.terms.filter((tt) => addedSet.has(tt.termId));
      case 'removed':
        // Removed entries are resolved server-side (getSnapshotDiff joins
        // removedIds against DomainTerm) so the user can see exactly which
        // terms a rollback would soft-delete before confirming.
        return diff.removedTerms;
      case 'unchanged':
        return diff.terms.filter((tt) => !addedSet.has(tt.termId));
      case 'all':
      default:
        return diff.terms;
    }
  })();

  return (
    <div
      className="fixed inset-0 z-30 flex justify-end p-0"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="absolute inset-0 bg-black/30"
        onClick={onClose}
      />
      <aside
        ref={panelRef}
        className="relative z-10 flex h-full w-full max-w-2xl flex-col bg-bg shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h2 id={titleId} className="font-display text-lg font-semibold text-fg">
              {t('title', {
                domain: snapshot.domain,
                locale: snapshot.locale,
                version: snapshot.version,
              })}
            </h2>
            <p className="mt-0.5 text-xs text-fg-muted">
              {t('subtitle', { termCount: snapshot.termCount })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('close')}
            className="rounded p-1 text-fg-muted hover:bg-bg-subtle hover:text-fg focus:outline-none focus-visible:shadow-ring"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {!diff && !error ? (
            <div className="flex items-center gap-2 text-sm text-fg-muted">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {t('loading')}
            </div>
          ) : null}

          {error ? (
            <Alert variant="danger">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {diff ? (
            <>
              <div className="grid grid-cols-3 gap-3" role="group" aria-label={t('summary')}>
                <BucketCard
                  tone="added"
                  count={diff.addedIds.length}
                  label={t('bucket.added')}
                  active={bucket === 'added'}
                  onClick={() => setBucket('added')}
                />
                <BucketCard
                  tone="removed"
                  count={diff.removedIds.length}
                  label={t('bucket.removed')}
                  active={bucket === 'removed'}
                  onClick={() => setBucket('removed')}
                />
                <BucketCard
                  tone="unchanged"
                  count={diff.unchangedIds.length}
                  label={t('bucket.unchanged')}
                  active={bucket === 'unchanged'}
                  onClick={() => setBucket('unchanged')}
                />
              </div>
              <div className="mt-3 flex items-center justify-between text-xs text-fg-muted">
                <button
                  type="button"
                  className="underline-offset-2 hover:underline focus:outline-none focus-visible:shadow-ring"
                  onClick={() => setBucket('all')}
                >
                  {t('bucket.all', { n: diff.terms.length })}
                </button>
              </div>

              {bucket === 'removed' && diff.removedIds.length > 0 ? (
                <Alert variant="info" className="mt-4">
                  <AlertDescription>
                    {t('removedNotice', { n: diff.removedIds.length })}
                  </AlertDescription>
                </Alert>
              ) : null}

              <ul className="mt-4 divide-y divide-border rounded-md border border-border">
                {visibleTerms.length === 0 ? (
                  <li className="px-4 py-3 text-sm text-fg-muted">{t('emptyBucket')}</li>
                ) : null}
                {visibleTerms.map((term) => (
                  <li key={term.termId} className="flex items-start gap-3 px-4 py-3">
                    <span className="mt-0.5">
                      {addedSet.has(term.termId) ? (
                        <ArrowUp
                          className="h-4 w-4 text-success"
                          aria-label={t('iconAdded')}
                        />
                      ) : removedSet.has(term.termId) ? (
                        <ArrowDown
                          className="h-4 w-4 text-danger"
                          aria-label={t('iconRemoved')}
                        />
                      ) : (
                        <Equal
                          className="h-4 w-4 text-fg-subtle"
                          aria-label={t('iconUnchanged')}
                        />
                      )}
                    </span>
                    <div className="flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="font-mono text-sm text-fg">{term.canonical}</code>
                        <Badge variant="neutral">{translateKind(tKinds, term.kind)}</Badge>
                        {term.parentCanonical ? (
                          <code className="font-mono text-xs text-fg-subtle">
                            ↳ {term.parentCanonical}
                          </code>
                        ) : null}
                      </div>
                      <p className="text-sm text-fg-muted">{term.localized}</p>
                      {term.aliases.length > 0 ? (
                        <p className="text-xs text-fg-subtle">
                          {term.aliases.join(', ')}
                        </p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('close')}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={!diff || snapshot.archived}
            onClick={onRollback}
          >
            {t('rollback')}
          </Button>
        </footer>
      </aside>
    </div>
  );
}

function translateKind(
  tKinds: ReturnType<typeof useTranslations<'domainVocabularies.kinds'>>,
  kind: string,
): string {
  if (kind === 'struct' || kind === 'field' || kind === 'function' || kind === 'enum_value') {
    return tKinds(kind);
  }
  return kind;
}

interface BucketCardProps {
  tone: 'added' | 'removed' | 'unchanged';
  count: number;
  label: string;
  active: boolean;
  onClick: () => void;
}

function BucketCard({ tone, count, label, active, onClick }: BucketCardProps) {
  const toneClasses: Record<typeof tone, string> = {
    added: active
      ? 'border-success bg-success-subtle text-success'
      : 'border-border bg-bg text-fg hover:bg-bg-subtle',
    removed: active
      ? 'border-danger bg-danger-subtle text-danger'
      : 'border-border bg-bg text-fg hover:bg-bg-subtle',
    unchanged: active
      ? 'border-border bg-bg-subtle text-fg'
      : 'border-border bg-bg text-fg hover:bg-bg-subtle',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex flex-col items-start rounded-md border px-3 py-2 text-left focus:outline-none focus-visible:shadow-ring ${toneClasses[tone]}`}
    >
      <span className="font-mono text-xl font-semibold">{count}</span>
      <span className="text-xs">{label}</span>
    </button>
  );
}
