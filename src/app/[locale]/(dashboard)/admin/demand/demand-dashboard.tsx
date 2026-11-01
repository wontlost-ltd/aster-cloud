/**
 * /admin/demand 的展示层（纯渲染，数据与文案由 page.tsx 注入，便于单测）。
 */
import type { ReactNode } from 'react';
import { StatCard, buttonVariants } from '@/components/ui';
import type { DemandReport } from '@/lib/product-events/report';
import { GUARD_API_EVENT, PRODUCT_EVENT_NAMES } from '@/lib/product-events/definitions';
import type { PilotApplication } from '@/lib/prisma';
import { DeleteApplicationButton } from './delete-application-button';

/** 周计数表的列顺序：漏斗事件在前，其余随后，Guard 调用（来自 API 用量）放最后。 */
const WEEKLY_COLUMNS = [...PRODUCT_EVENT_NAMES, GUARD_API_EVENT];

export type DemandLabels = (key: string, values?: Record<string, string | number>) => string;

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—';
}

function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="text-sm font-semibold uppercase tracking-wider text-fg-muted">{title}</h2>
      {note && <p className="text-sm text-fg-muted">{note}</p>}
      {children}
    </section>
  );
}

function Table({ head, rows, empty }: { head: string[]; rows: ReactNode[][]; empty: string }) {
  if (rows.length === 0) return <p className="text-sm text-fg-muted">{empty}</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="min-w-full divide-y divide-border text-sm">
        <thead className="bg-bg-subtle">
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col" className="whitespace-nowrap px-3 py-2 text-left font-medium text-fg-muted">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((cells, i) => (
            <tr key={i}>
              {cells.map((c, j) => (
                <td key={j} className="whitespace-nowrap px-3 py-2 tabular-nums text-fg">{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DemandDashboard({
  report,
  applications,
  t,
  exportHref,
}: {
  report: DemandReport;
  applications: PilotApplication[];
  t: DemandLabels;
  exportHref: string;
}) {
  const { funnel } = report;
  const weeks = [...new Set(report.weekly.map((r) => r.week))];
  const countOf = (week: string, name: string) =>
    report.weekly.find((r) => r.week === week && r.name === name)?.count ?? 0;

  return (
    <div className="space-y-10">
      <p className="text-sm text-fg-muted">
        {t('window', { since: report.since.toISOString().slice(0, 10) })} {t('privacyNote')} {t('retentionNote')}
      </p>

      <Section id="demand-funnel" title={t('funnel.heading')} note={t('funnel.note')}>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <StatCard label={t('funnel.signups')} value={String(funnel.signups)} />
          <StatCard label={t('funnel.verifiedSignups')} value={String(funnel.verifiedSignups)} />
          <StatCard label={t('funnel.firstSaved')} value={String(funnel.firstSaved)} hint={t('funnel.ofSignups', { pct: percent(funnel.firstSaved, funnel.verifiedSignups) })} />
          <StatCard label={t('funnel.firstExecuted')} value={String(funnel.firstExecuted)} hint={t('funnel.ofSignups', { pct: percent(funnel.firstExecuted, funnel.verifiedSignups) })} />
          <StatCard label={t('funnel.evidenceExported')} value={String(funnel.evidenceExported)} hint={t('funnel.ofSignups', { pct: percent(funnel.evidenceExported, funnel.verifiedSignups) })} />
        </div>
      </Section>

      <Section id="demand-weekly" title={t('weekly.heading')} note={t('weekly.note')}>
        <Table
          head={[t('weekly.week'), ...WEEKLY_COLUMNS]}
          rows={weeks.map((w) => [w, ...WEEKLY_COLUMNS.map((name) => countOf(w, name))])}
          empty={t('empty')}
        />
      </Section>

      <div className="grid gap-10 lg:grid-cols-2">
        <Section id="demand-templates" title={t('templates.heading')}>
          <Table
            head={[t('templates.template'), t('count')]}
            rows={report.templates.map((r) => [<code key="id">{r.templateId}</code>, r.count])}
            empty={t('empty')}
          />
        </Section>
        <Section id="demand-landing" title={t('landing.heading')} note={t('landing.note')}>
          <Table
            head={[t('landing.page'), t('landing.views'), t('landing.submissions'), t('landing.rate')]}
            rows={report.landing.map((r) => [`/solutions/${r.page}`, r.views, r.submissions, percent(r.submissions, r.views)])}
            empty={t('empty')}
          />
        </Section>
        <Section id="demand-sources" title={t('sources.heading')}>
          <Table
            head={[t('sources.source'), t('landing.views')]}
            rows={report.sources.map((r) => [r.source, r.views])}
            empty={t('empty')}
          />
        </Section>
        <Section id="demand-guard" title={t('guard.heading')} note={t('guard.note')}>
          <Table
            head={[t('guard.tenant'), t('count')]}
            rows={report.guardByTenant.map((r) => [<code key="t">{r.tenant}</code>, r.count])}
            empty={t('empty')}
          />
        </Section>
      </div>

      <Section id="demand-applications" title={t('applications.heading', { count: applications.length })}>
        <a href={exportHref} className={buttonVariants({ variant: 'outline', size: 'sm' })} download>
          {t('applications.export')}
        </a>
        <Table
          head={[
            t('applications.createdAt'), t('applications.email'), t('applications.mailbox'), t('applications.company'),
            t('applications.role'), t('applications.useCases'), t('applications.page'), t('applications.source'),
            t('applications.painPoint'), '',
          ]}
          rows={applications.map((a) => [
            a.createdAt.toISOString().slice(0, 16).replace('T', ' '),
            a.email,
            a.freeMailDomain ? t('applications.personalMailbox') : t('applications.companyDomain'),
            a.company,
            a.role,
            a.useCases.join(', '),
            a.landingPage,
            a.utmSource ?? a.referrerHost ?? '—',
            <span key="p" className="block max-w-xs truncate" title={a.painPoint ?? ''}>{a.painPoint ?? '—'}</span>,
            <DeleteApplicationButton
              key="d"
              id={a.id}
              labels={{
                delete: t('applications.delete'),
                confirm: t('applications.deleteConfirm'),
                failed: t('applications.deleteFailed'),
              }}
            />,
          ])}
          empty={t('empty')}
        />
      </Section>
    </div>
  );
}
