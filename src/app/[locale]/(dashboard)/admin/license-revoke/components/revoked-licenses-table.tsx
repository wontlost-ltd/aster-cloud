// RevokedLicensesTable — active revocation list。
//
// 设计意图：
//   - 表格适合 support/security auditor 扫描 opaque licenseId、reason、operator
//   - undo window 是时间敏感动作，挂在每行末尾并在窗口过期后显式禁用
//   - 相对时间只在 mount 后计算，避免 server/client 时钟差造成 hydration mismatch

'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { RevokedLicense } from '../revocation-content';
import {
  CopyableValue,
} from '../../license/components/license-details';

type SortKey = 'licenseId' | 'reason' | 'revokedAt' | 'revokedBy';
type SortDirection = 'asc' | 'desc';

interface Props {
  revoked: RevokedLicense[];
}

export function RevokedLicensesTable({ revoked }: Props) {
  const t = useTranslations('admin.licenseRevoke');
  const router = useRouter();
  const [sortKey, setSortKey] = useState<SortKey>('revokedAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [nowMs, setNowMs] = useState<number | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    // 仅在 mount 后读取客户端时钟，避免 server/client 时钟差造成 hydration mismatch，故意在 effect 内 set
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const sorted = useMemo(() => {
    return [...revoked].sort((a, b) => {
      const aValue = valueForSort(a, sortKey);
      const bValue = valueForSort(b, sortKey);
      const result = aValue.localeCompare(bValue);
      return sortDirection === 'asc' ? result : -result;
    });
  }, [revoked, sortDirection, sortKey]);

  function updateSort(key: SortKey) {
    if (key === sortKey) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(key);
    setSortDirection(key === 'revokedAt' ? 'desc' : 'asc');
  }

  async function undo(license: RevokedLicense) {
    if (!window.confirm(t('table.undoConfirm', { licenseId: license.licenseId }))) {
      return;
    }
    try {
      const response = await fetch(
        `/api/admin/license-revoke/${encodeURIComponent(license.licenseId)}`,
        { method: 'DELETE', headers: { Accept: 'application/json' } },
      );
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? response.statusText);
      setMessage(t('table.undoSuccess', { licenseId: license.licenseId }));
      router.refresh();
    } catch (error) {
      setMessage(
        t('table.undoError', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  return (
    <section
      aria-labelledby="revoked-licenses-heading"
      className="rounded-lg border border-border bg-bg p-5"
    >
      <h2
        id="revoked-licenses-heading"
        className="mb-4 text-base font-semibold text-fg"
      >
        {t('table.heading')}
      </h2>

      {revoked.length === 0 ? (
        <p className="rounded border border-border bg-bg-subtle px-3 py-6 text-center text-sm text-fg-muted">
          {t('table.empty')}
        </p>
      ) : (
        <div tabIndex={0} role="region" aria-label={t('table.heading')} data-scroll-region className="overflow-x-auto">
          <table className="min-w-full border-separate border-spacing-0 text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase text-fg-muted">
                <SortableHeader label={t('table.licenseId')} sortKey="licenseId" activeSortKey={sortKey} direction={sortDirection} onSort={updateSort} />
                <SortableHeader label={t('table.reason')} sortKey="reason" activeSortKey={sortKey} direction={sortDirection} onSort={updateSort} />
                <SortableHeader label={t('table.revokedAt')} sortKey="revokedAt" activeSortKey={sortKey} direction={sortDirection} onSort={updateSort} />
                <SortableHeader label={t('table.revokedBy')} sortKey="revokedBy" activeSortKey={sortKey} direction={sortDirection} onSort={updateSort} />
                <th scope="col" className="border-b border-border px-3 py-2">
                  {t('table.customerRef')}
                </th>
                <th scope="col" className="border-b border-border px-3 py-2">
                  {t('table.notes')}
                </th>
                <th scope="col" className="border-b border-border px-3 py-2">
                  {t('table.undo')}
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((license) => {
                const undoState = getUndoState(license.undoExpiresAt, nowMs);
                return (
                  <tr key={license.licenseId} className="border-b border-border">
                    <td className="border-b border-border px-3 py-3 align-top">
                      <CopyableValue
                        label={t('table.licenseId')}
                        value={license.licenseId}
                      />
                    </td>
                    <td className="border-b border-border px-3 py-3 align-top">
                      <span className="rounded bg-bg-subtle px-2 py-1 text-xs font-medium text-fg">
                        {t(`newForm.reasonOptions.${license.reason}`)}
                      </span>
                    </td>
                    <td className="border-b border-border px-3 py-3 align-top">
                      <time dateTime={license.revokedAt} title={license.revokedAt}>
                        {nowMs
                          ? t('table.revokedHoursAgo', {
                              hours: Math.max(
                                1,
                                Math.floor(
                                  (nowMs - Date.parse(license.revokedAt)) /
                                    3_600_000,
                                ),
                              ),
                            })
                          : license.revokedAt}
                      </time>
                    </td>
                    <td className="border-b border-border px-3 py-3 align-top">
                      <span className="break-all">{license.revokedBy}</span>
                    </td>
                    <td className="border-b border-border px-3 py-3 align-top">
                      {license.customerRef || '—'}
                    </td>
                    <td className="max-w-xs border-b border-border px-3 py-3 align-top">
                      <span className="line-clamp-3">{license.notes || '—'}</span>
                    </td>
                    <td className="border-b border-border px-3 py-3 align-top">
                      <button
                        type="button"
                        onClick={() => undo(license)}
                        disabled={!undoState.enabled}
                        // codex 审查 Major-3：button 必须有意义的 accessible name
                        // 仅显示 "5h" 对屏幕阅读器没语义；用 ICU 完整句子作 aria-label
                        aria-label={
                          undoState.enabled
                            ? t('table.undoAriaLabel', {
                                licenseId: license.licenseId,
                                hours: undoState.hoursLeft,
                              })
                            : t('table.undoExpiredAriaLabel', {
                                licenseId: license.licenseId,
                              })
                        }
                        title={
                          undoState.enabled
                            ? t('table.undoCountdown', { hours: undoState.hoursLeft })
                            : t('table.undoExpired')
                        }
                        className="rounded border border-border px-2 py-1 text-xs font-medium text-fg hover:bg-bg-subtle disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-primary/40"
                      >
                        {undoState.enabled
                          ? t('table.undoCountdown', { hours: undoState.hoursLeft })
                          : t('table.undoExpired')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p aria-live="polite" className="mt-3 min-h-5 text-sm text-fg-muted">
        {message}
      </p>
    </section>
  );
}

function SortableHeader({
  label,
  sortKey,
  activeSortKey,
  direction,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  activeSortKey: SortKey;
  direction: SortDirection;
  onSort: (key: SortKey) => void;
}) {
  const active = sortKey === activeSortKey;
  // codex 审查 Major-4：aria-sort 让屏幕阅读器知道当前排序状态
  const ariaSort: 'ascending' | 'descending' | 'none' = active
    ? direction === 'asc'
      ? 'ascending'
      : 'descending'
    : 'none';
  return (
    <th scope="col" aria-sort={ariaSort} className="border-b border-border px-3 py-2">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1 font-semibold hover:text-fg focus:outline-none focus:underline"
      >
        {label}
        <span aria-hidden="true">{active ? (direction === 'asc' ? '↑' : '↓') : ''}</span>
      </button>
    </th>
  );
}

function valueForSort(license: RevokedLicense, key: SortKey): string {
  if (key === 'revokedAt') return license.revokedAt;
  return license[key] ?? '';
}

function getUndoState(undoExpiresAt: string | undefined, nowMs: number | null) {
  if (!undoExpiresAt || !nowMs) {
    return { enabled: false, hoursLeft: 0 };
  }
  const remainingMs = Date.parse(undoExpiresAt) - nowMs;
  if (remainingMs <= 0) {
    return { enabled: false, hoursLeft: 0 };
  }
  return {
    enabled: true,
    hoursLeft: Math.max(1, Math.ceil(remainingMs / 3_600_000)),
  };
}
