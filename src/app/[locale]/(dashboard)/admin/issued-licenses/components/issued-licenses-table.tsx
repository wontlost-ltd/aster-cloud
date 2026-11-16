// IssuedLicensesTable — ops-grade master list view.
//
// One row per IssuedLicense. Columns are chosen so the most-asked
// renewal-time question — "is this license active, pending renewal, or
// already superseded?" — is answerable from the row at a glance.
//
// Telemetry recency column lets ops spot deployments that opted in but
// then stopped phoning home (silent indicator of customer issues).

import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import type { IssuedLicense, LicenseTelemetry } from '@/lib/prisma';

export interface RowWithTelemetry extends IssuedLicense {
  latestTelemetry: LicenseTelemetry | null;
}

interface Props {
  rows: RowWithTelemetry[];
  searchQuery: string;
}

type LifecyclePhase = 'active' | 'expiring-soon' | 'expired' | 'superseded' | 'pending-renewal';

function derivePhase(row: IssuedLicense): LifecyclePhase {
  if (row.supersededAt) return 'superseded';
  const now = Date.now();
  const expires = row.expiresAt.getTime();
  const daysLeft = (expires - now) / 86_400_000;
  if (row.supersededBy && !row.supersededAt) return 'pending-renewal';
  if (expires <= now) return 'expired';
  if (daysLeft < 14) return 'expiring-soon';
  return 'active';
}

function phaseStyle(phase: LifecyclePhase): string {
  switch (phase) {
    case 'active':
      return 'bg-emerald-500/15 text-emerald-300';
    case 'expiring-soon':
      return 'bg-amber-500/15 text-amber-300';
    case 'expired':
      return 'bg-rose-500/15 text-rose-300';
    case 'superseded':
      return 'bg-zinc-500/15 text-zinc-400';
    case 'pending-renewal':
      return 'bg-sky-500/15 text-sky-300';
  }
}

function telemetryRecencyLabel(received: Date | null, optedIn: boolean, t: ReturnType<typeof useTranslations>): string {
  // We can't know opt-in from this row alone; we infer "ever reported"
  // = telemetry signed up sometime, so absent telemetry rows means
  // either never opted in OR stopped. Both are interesting to ops.
  if (!received) return optedIn ? t('telemetry.silent') : t('telemetry.notOptedIn');
  const ageDays = (Date.now() - received.getTime()) / 86_400_000;
  if (ageDays < 2) return t('telemetry.recent', { days: Math.floor(ageDays) });
  if (ageDays < 14) return t('telemetry.daysAgo', { days: Math.floor(ageDays) });
  return t('telemetry.stale', { days: Math.floor(ageDays) });
}

export function IssuedLicensesTable({ rows, searchQuery }: Props) {
  const t = useTranslations('admin.issuedLicenses');

  // 不再放与页面 h1 同名的 sr-only h2（读屏会读到两遍「Issued licenses」标题，#774）；
  // 区域名只给下面的表格滚动容器，外层不再重复命名
  return (
    <section className="space-y-3">
      <form method="GET" className="flex items-center gap-2">
        <input
          type="search"
          name="q"
          defaultValue={searchQuery}
          placeholder={t('searchPlaceholder')}
          className="w-full max-w-md rounded border border-border bg-bg-subtle px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        <button
          type="submit"
          className="rounded border border-border bg-bg-subtle px-3 py-2 text-sm text-fg hover:bg-bg-subtle/80"
        >
          {t('searchButton')}
        </button>
      </form>

      {/* 可横向滚动的表格容器：键盘可聚焦后用方向键滚动（axe scrollable-region-focusable，#774） */}
      <div tabIndex={0} role="region" aria-label={t('title')} data-scroll-region className="overflow-x-auto rounded-lg border border-border">
        <table className="min-w-full text-sm">
          <thead className="bg-bg-subtle text-xs uppercase text-fg-muted">
            <tr>
              <Th>{t('cols.customer')}</Th>
              <Th>{t('cols.licenseId')}</Th>
              <Th>{t('cols.tier')}</Th>
              <Th>{t('cols.term')}</Th>
              <Th>{t('cols.signedAt')}</Th>
              <Th>{t('cols.expiresAt')}</Th>
              <Th>{t('cols.phase')}</Th>
              <Th>{t('cols.lineage')}</Th>
              <Th>{t('cols.telemetry')}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-fg-muted">
                  {t('emptyMatching')}
                </td>
              </tr>
            )}
            {rows.map((row) => {
              const phase = derivePhase(row);
              const telemetryOpted =
                row.latestTelemetry !== null ||
                (row.payloadJson as { telemetry?: { secrets?: unknown[] } })?.telemetry?.secrets
                  ?.length !== undefined;
              return (
                <tr key={row.licenseId} className="border-t border-border align-top">
                  <Td>
                    <span className="font-medium text-fg">{row.customer}</span>
                  </Td>
                  <Td>
                    <code className="font-mono text-xs text-fg-muted">{row.licenseId}</code>
                  </Td>
                  <Td>{row.tier}</Td>
                  <Td>{row.licenseTerm}</Td>
                  <Td>
                    <time dateTime={row.signedAt.toISOString()} className="font-mono text-xs">
                      {row.signedAt.toISOString().slice(0, 10)}
                    </time>
                  </Td>
                  <Td>
                    <time dateTime={row.expiresAt.toISOString()} className="font-mono text-xs">
                      {row.expiresAt.toISOString().slice(0, 10)}
                    </time>
                  </Td>
                  <Td>
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${phaseStyle(phase)}`}>
                      {t(`phase.${phase}`)}
                    </span>
                  </Td>
                  <Td>
                    <LineageCell row={row} t={t} />
                  </Td>
                  <Td>
                    <span
                      className={
                        row.latestTelemetry
                          ? 'text-fg-muted'
                          : telemetryOpted
                            ? 'text-amber-400'
                            : 'text-fg-subtle'
                      }
                    >
                      {telemetryRecencyLabel(
                        row.latestTelemetry?.receivedAt ?? null,
                        telemetryOpted,
                        t,
                      )}
                    </span>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-fg-subtle">
        {t('shownCount', { n: rows.length })}
      </p>
    </section>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 text-left font-medium">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-2">{children}</td>;
}

function LineageCell({
  row,
  t,
}: {
  row: IssuedLicense;
  t: ReturnType<typeof useTranslations>;
}) {
  const items: Array<{ label: string; href?: string }> = [];
  if (row.renewedFromLicenseId) {
    items.push({
      label: t('lineage.renewedFrom', { id: row.renewedFromLicenseId.slice(0, 10) }),
      href: `?q=${encodeURIComponent(row.renewedFromLicenseId)}`,
    });
  }
  if (row.supersededBy) {
    items.push({
      label: t('lineage.supersededBy', { id: row.supersededBy.slice(0, 10) }),
      href: `?q=${encodeURIComponent(row.supersededBy)}`,
    });
  }
  if (items.length === 0) {
    return <span className="text-fg-subtle">—</span>;
  }
  return (
    <ul className="space-y-1 text-xs">
      {items.map((item) =>
        item.href ? (
          <li key={item.label}>
            <Link href={item.href} className="text-primary hover:underline">
              {item.label}
            </Link>
          </li>
        ) : (
          <li key={item.label}>{item.label}</li>
        ),
      )}
    </ul>
  );
}
