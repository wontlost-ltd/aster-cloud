'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Alert,
  Badge,
  Breadcrumbs,
  Button,
  Card,
  CardBody,
  Container,
  EmptyState,
  Input,
  Label,
  PageHeader,
  Select,
  Stack,
} from '@/components/ui';
import { extractErrorMessage } from '@/lib/api/error-envelope';

interface PolicyOption {
  id: string;
  name: string;
}

interface EvidenceExportRow {
  id: string;
  title: string;
  status: 'generating' | 'completed' | 'failed';
  period: string | null;
  count: number | null;
  bundleHash: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface Preview {
  count: number;
  decisionTally: {
    approved: number;
    denied: number;
    indeterminate: number;
    error: number;
    require_approval: number;
    escalate: number;
    unknown: number;
  };
  coverage: { verifiable: number; legacy: number };
  exceedsLimit: boolean;
  limit: number;
}

interface Props {
  locale: string;
  policies: PolicyOption[];
  initialExports: EvidenceExportRow[];
}

const DECISION_KEYS = [
  'approved',
  'denied',
  'indeterminate',
  'error',
  'require_approval',
  'escalate',
  'unknown',
] as const;

export function ReportsContent({ locale, policies, initialExports }: Props) {
  const t = useTranslations('evidenceExport');
  const [policyId, setPolicyId] = useState<string>(''); // '' = 全部
  const [startDate, setStartDate] = useState<string>(defaultStart());
  const [endDate, setEndDate] = useState<string>('');
  const [format, setFormat] = useState<'json' | 'jsonl'>('json');
  const [verifiableOnly, setVerifiableOnly] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exports, setExports] = useState<EvidenceExportRow[]>(initialExports);

  const rangePayload = () => ({
    policyId: policyId || null,
    // date input 是 YYYY-MM-DD；start 取当天 00:00Z，end 取当天 23:59:59Z（含当天）。
    startDate: startDate ? new Date(startDate + 'T00:00:00Z').toISOString() : null,
    endDate: endDate ? new Date(endDate + 'T23:59:59Z').toISOString() : null,
  });

  const runPreview = async () => {
    setError(null);
    setPreviewing(true);
    try {
      const r = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...rangePayload(), dryRun: true }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        setError(extractErrorMessage(data) || t('previewFailed', { status: r.status }));
        setPreview(null);
        return;
      }
      setPreview((await r.json()) as Preview);
    } finally {
      setPreviewing(false);
    }
  };

  const refresh = async () => {
    const r = await fetch('/api/reports');
    if (r.ok) {
      const rows = (await r.json()) as Array<{
        id: string;
        title: string;
        status: EvidenceExportRow['status'];
        period: string | null;
        data: { manifest?: { totals?: { count?: number }; bundleHash?: string } } | null;
        createdAt: string;
        completedAt: string | null;
      }>;
      setExports(
        rows.map((e) => ({
          id: e.id,
          title: e.title,
          status: e.status,
          period: e.period ?? null,
          count: e.data?.manifest?.totals?.count ?? null,
          bundleHash: e.data?.manifest?.bundleHash ?? null,
          createdAt: e.createdAt,
          completedAt: e.completedAt,
        })),
      );
    }
  };

  const runExport = async () => {
    setError(null);
    setExporting(true);
    try {
      const r = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...rangePayload(), format, verifiableOnly }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        setError(extractErrorMessage(data) || t('exportFailed', { status: r.status }));
        return;
      }
      const { id } = (await r.json()) as { id: string };
      await refresh();
      // 触发下载。
      window.location.href = `/api/reports/${encodeURIComponent(id)}/download`;
    } finally {
      setExporting(false);
    }
  };

  const canExport = !exporting && (preview === null || (!preview.exceedsLimit && preview.count > 0));

  return (
    <Container size="xl" className="py-6 sm:py-10">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        breadcrumbs={<Breadcrumbs items={[{ label: t('breadcrumb') }]} />}
        className="mb-6"
      />

      {/* 导出配置 */}
      <Card>
        <CardBody className="pt-6">
          <Stack gap={4}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ev-policy">{t('policy')}</Label>
              <Select id="ev-policy" value={policyId} onChange={(e) => setPolicyId(e.target.value)}>
                <option value="">{t('allPolicies')}</option>
                {policies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="ev-start">{t('startDate')}</Label>
                <Input id="ev-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="ev-end">{t('endDate')}</Label>
                <Input id="ev-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="ev-format">{t('format')}</Label>
              <Select
                id="ev-format"
                value={format}
                onChange={(e) => setFormat(e.target.value as 'json' | 'jsonl')}
                className="sm:w-48"
              >
                <option value="json">JSON</option>
                <option value="jsonl">JSONL</option>
              </Select>
            </div>

            {/* 仅导有可验证哈希的执行（排除早于哈希采集接线的 legacy 行）。 */}
            <label className="flex items-start gap-2 text-sm text-fg">
              <input
                type="checkbox"
                checked={verifiableOnly}
                onChange={(e) => setVerifiableOnly(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                {t('verifiableOnly')}
                <span className="mt-0.5 block text-xs text-fg-muted">{t('verifiableOnlyHint')}</span>
              </span>
            </label>

            <Stack direction="row" gap={3} align="center">
              <Button variant="secondary" onClick={runPreview} disabled={previewing}>
                {previewing ? t('previewing') : t('previewBtn')}
              </Button>
              <Button variant="primary" onClick={runExport} disabled={!canExport}>
                {exporting ? t('exporting') : t('exportBtn')}
              </Button>
            </Stack>

            {error && <Alert variant="danger">{error}</Alert>}

            {/* 预览面板 */}
            {preview && (
              <div className="rounded-md border border-border bg-bg-subtle p-4">
                <p className="text-sm font-medium text-fg">
                  {t('previewCount', { count: preview.count })}
                </p>
                {preview.count === 0 ? (
                  <p className="mt-2 text-sm text-fg-muted">{t('previewEmpty')}</p>
                ) : preview.exceedsLimit ? (
                  <Alert variant="warning" className="mt-2">
                    {t('previewTooLarge', { limit: preview.limit })}
                  </Alert>
                ) : (
                  <>
                    {/* 哈希覆盖率：多少条真有可验证证据 vs 早期无哈希 legacy 行。 */}
                    <p className="mt-2 text-sm text-fg-muted">
                      {t('previewCoverage', {
                        verifiable: preview.coverage.verifiable,
                        legacy: preview.coverage.legacy,
                      })}
                    </p>
                    {/* 全部都是无哈希 legacy → 明确警告导出会全 null（除非勾「仅可验证」，此时导出为空）。 */}
                    {preview.coverage.verifiable === 0 && (
                      <Alert variant="warning" className="mt-2">
                        {t('previewAllLegacy')}
                      </Alert>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {DECISION_KEYS.map((k) => (
                        <Badge key={k} variant={decisionVariant(k)}>
                          {t(`decision.${k}`)}: {preview.decisionTally[k]}
                        </Badge>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </Stack>
        </CardBody>
      </Card>

      {/* 说明：证据包是什么 */}
      <section className="mt-6 rounded-lg border border-border bg-bg-subtle p-6">
        <h3 className="text-base font-semibold text-fg">{t('whatTitle')}</h3>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-fg">
          <li>{t('whatEvidence')}</li>
          <li>{t('whatHash')}</li>
          <li>{t('whatNoScore')}</li>
        </ul>
      </section>

      {/* 历史导出 */}
      <section className="mt-6">
        <h2 className="mb-3 text-lg font-semibold text-fg">{t('historyTitle')}</h2>
        {exports.length === 0 ? (
          <EmptyState title={t('historyEmpty')} description={t('historyEmptyDesc')} />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase text-fg-muted">
                  <th className="px-4 py-2 text-left">{t('thTitle')}</th>
                  <th className="px-4 py-2 text-left">{t('thCount')}</th>
                  <th className="px-4 py-2 text-left">{t('thStatus')}</th>
                  <th className="px-4 py-2 text-left">{t('thCreated')}</th>
                  <th className="px-4 py-2 text-left">{t('thActions')}</th>
                </tr>
              </thead>
              <tbody>
                {exports.map((e) => (
                  <tr key={e.id} className="border-b border-border">
                    <td className="px-4 py-3">{e.title}</td>
                    <td className="px-4 py-3 text-fg-muted">{e.count ?? '—'}</td>
                    <td className="px-4 py-3">
                      <Badge variant={e.status === 'completed' ? 'success' : e.status === 'failed' ? 'danger' : 'neutral'}>
                        {t(`status.${e.status}`)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-fg-muted">
                      {new Date(e.createdAt).toLocaleString(locale)}
                    </td>
                    <td className="px-4 py-3">
                      {e.status === 'completed' ? (
                        <a
                          href={`/api/reports/${encodeURIComponent(e.id)}/download`}
                          className="text-xs text-primary hover:underline"
                        >
                          {t('download')}
                        </a>
                      ) : (
                        <span className="text-xs text-fg-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Container>
  );
}

function decisionVariant(k: (typeof DECISION_KEYS)[number]): 'success' | 'danger' | 'neutral' | 'warning' {
  switch (k) {
    case 'approved':
      return 'success';
    case 'denied':
    case 'error':
      return 'danger';
    case 'indeterminate':
    case 'require_approval':
    case 'escalate':
      return 'warning';
    default:
      return 'neutral';
  }
}

/** 默认起始日 = 30 天前（YYYY-MM-DD）。 */
function defaultStart(): string {
  const d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}
