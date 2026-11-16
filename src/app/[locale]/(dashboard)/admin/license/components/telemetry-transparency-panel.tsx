// TelemetryTransparencyPanel — show ops exactly what telemetry was last
// shipped (or not). Server component reads LicenseCache.lastTelemetryUpload
// jsonb directly so there's no extra API roundtrip and no client-side
// fetch that could be MITM'd.
//
// Three states:
//   - opt-out (env absent): show single line "Telemetry: disabled"
//   - opt-in + never uploaded yet: "Telemetry: enabled, no upload yet"
//   - opt-in + at least one attempt: show payload preview + outcome
//
// Surface design choice: render the *exact* aggregate values, not a
// summary. Trust comes from "I can see every counter we sent" — paraphrasing
// breaks that.

import { useTranslations } from 'next-intl';

export interface TelemetryUploadRecord {
  payload: {
    schemaVersion: number;
    periodStart: string;
    periodEnd: string;
    activeSeats: number;
    policiesActive: number;
    policyExecutionsCount: number;
    totalProvisionedSeats: number;
    seatLimitHit: boolean;
    featuresUsed: string[];
    appVersion?: string;
    nodeVersion?: string;
  };
  attemptedAt: string;
  outcome: 'accepted' | 'deduped' | 'failed';
  ingestId?: string;
  errorKind?: string;
  errorStatus?: number | null;
  errorMessage?: string;
  /** GDPR Art 44 evidence — where the SaaS persisted this row (us/eu/apac/unknown). */
  dataRegion?: string;
  /** Whether the customer-name header was masked (ASTER_TELEMETRY_MASK_CUSTOMER=1). */
  customerMasked?: boolean;
  /** J4: SaaS-published versions when outcome=failed + errorKind=unsupported-schema-version. */
  supportedVersions?: number[];
}

interface Props {
  optedIn: boolean;
  lastUpload: TelemetryUploadRecord | null;
}

export function TelemetryTransparencyPanel({ optedIn, lastUpload }: Props) {
  const t = useTranslations('admin.license.telemetry');

  return (
    <section
      aria-labelledby="telemetry-transparency-heading"
      className="rounded-lg border border-border bg-bg p-5"
    >
      <h2 id="telemetry-transparency-heading" className="mb-3 text-base font-semibold text-fg">
        {t('heading')}
      </h2>

      {!optedIn ? (
        <p className="text-sm text-fg-muted">{t('optedOut')}</p>
      ) : !lastUpload ? (
        <p className="text-sm text-fg-muted">{t('optedInNoUpload')}</p>
      ) : (
        <RenderUpload record={lastUpload} t={t} />
      )}
    </section>
  );
}

function RenderUpload({
  record,
  t,
}: {
  record: TelemetryUploadRecord;
  t: ReturnType<typeof useTranslations>;
}) {
  const outcomeColor =
    record.outcome === 'failed'
      ? 'text-rose-400'
      : record.outcome === 'accepted'
        ? 'text-success'
        : 'text-warning';

  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-3 text-sm">
        <span className="text-fg-muted">{t('lastAttempt')}</span>
        <span className="font-mono text-xs text-fg">
          {new Date(record.attemptedAt).toISOString().replace('T', ' ').slice(0, 19)} UTC
        </span>
        <span className={`text-xs font-semibold uppercase ${outcomeColor}`}>
          {t(`outcome.${record.outcome}`)}
        </span>
      </div>

      {record.outcome === 'failed' && (
        <p role="alert" className="text-xs text-danger">
          {record.errorKind}: {record.errorMessage ?? t('unknownError')}
        </p>
      )}
      {record.outcome === 'failed' &&
        record.errorKind === 'unsupported-schema-version' &&
        record.supportedVersions && (
          <p className="text-xs text-warning">
            {t('schemaVersionUpgradeRequired', {
              versions: record.supportedVersions.join(', '),
            })}
          </p>
        )}

      <details className="text-xs">
        <summary className="cursor-pointer text-fg-muted">{t('viewSentBody')}</summary>
        <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 font-mono">
          <dt className="text-fg-muted">period</dt>
          <dd className="text-fg">
            {record.payload.periodStart.slice(0, 10)} → {record.payload.periodEnd.slice(0, 10)}
          </dd>
          <dt className="text-fg-muted">activeSeats</dt>
          <dd>{record.payload.activeSeats}</dd>
          <dt className="text-fg-muted">totalProvisionedSeats</dt>
          <dd>{record.payload.totalProvisionedSeats}</dd>
          <dt className="text-fg-muted">policiesActive</dt>
          <dd>{record.payload.policiesActive}</dd>
          <dt className="text-fg-muted">policyExecutionsCount</dt>
          <dd>{record.payload.policyExecutionsCount}</dd>
          <dt className="text-fg-muted">seatLimitHit</dt>
          <dd>{String(record.payload.seatLimitHit)}</dd>
          <dt className="text-fg-muted">featuresUsed</dt>
          <dd>{record.payload.featuresUsed.join(', ') || '(none)'}</dd>
          {record.payload.appVersion && (
            <>
              <dt className="text-fg-muted">appVersion</dt>
              <dd>{record.payload.appVersion}</dd>
            </>
          )}
          {record.ingestId && (
            <>
              <dt className="text-fg-muted">ingestId</dt>
              <dd>{record.ingestId}</dd>
            </>
          )}
          {record.dataRegion && (
            <>
              <dt className="text-fg-muted">{t('dataRegion')}</dt>
              <dd>{record.dataRegion}</dd>
            </>
          )}
          <>
            <dt className="text-fg-muted">{t('customerHeader')}</dt>
            <dd>{record.customerMasked ? t('customerMaskedYes') : t('customerMaskedNo')}</dd>
          </>
        </dl>
      </details>
    </div>
  );
}
