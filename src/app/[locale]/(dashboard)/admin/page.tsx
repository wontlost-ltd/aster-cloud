// /admin —— admin 概览页 + 实时 pulse。
//
// Two sections:
//   1. Admin Pulse — health signals visible in the first viewport so an
//      admin who lands here immediately knows the state of the platform.
//      Cards render in parallel: AI circuit, risk-tier queue size,
//      recent admin audit events. Each card is independent and fail-soft
//      (a single query failure shows that one card as "unavailable",
//      not the whole page).
//   2. Tools — the existing card grid that links into each admin sub-tool.
//
// Permission gate lives on admin/layout.tsx; this page does not re-check.

import { setRequestLocale, getTranslations } from 'next-intl/server';
import { desc, gte, sql } from 'drizzle-orm';
import { db, users, auditLogs } from '@/lib/prisma';
import { Link } from '@/i18n/navigation';
import { Container, PageHeader } from '@/components/ui';
import { formatDate } from '@/lib/format';
import { adminEventLabel } from '@/lib/admin-event-labels';
import { FeatureFlagsCard } from '@/components/admin/feature-flags-card';
import { RunnerParityCard } from '@/components/admin/runner-parity-card';
import { PlatformLanguageCard } from '@/components/admin/platform-language-card';
import { StructuralAliasGrantsCard } from '@/components/admin/structural-alias-grants-card';
import { ByokAllowlistCard } from '@/components/admin/byok-allowlist-card';
import {
  CAN_RISKTIER,
  CAN_LICENSE,
  CAN_SSO,
  IS_SAAS,
} from '@/lib/deployment-mode';
import { getCircuitStatus, type CircuitState } from '@/lib/ai-circuit-breaker';
import { localizedTitle } from '@/lib/page-metadata';

export const generateMetadata = localizedTitle('admin.overview', 'title');

type Props = {
  params: Promise<{ locale: string }>;
};

export const dynamic = 'force-dynamic';

type CircuitPulseState = CircuitState | 'error';

interface PulseSignals {
  circuit: {
    state: CircuitPulseState;
    todayUsd: string | null;
  };
  riskTierQueue: { count: number | null };
  recentAudit: {
    rows: Array<{ id: string; action: string; createdAt: string }>;
    error: boolean;
  };
}

/**
 * Resolve the three pulse signals in parallel. Each .catch wraps the
 * specific failure into a sentinel value so the page never throws at
 * the segment level — admin/error.tsx is a backstop, not a happy path.
 */
async function loadPulse(): Promise<PulseSignals> {
  const [circuit, riskCount, audit] = await Promise.all([
    (async () => {
      try {
        // 与熔断器页同一状态来源（含手动熔断），避免两处口径不一致。
        const status = await getCircuitStatus();
        return {
          state: status.state,
          todayUsd: (status.todayCents / 100).toFixed(2),
        } as const;
      } catch {
        return { state: 'error' as const, todayUsd: null };
      }
    })(),
    (async () => {
      if (!CAN_RISKTIER) return { count: null };
      try {
        const rows = await db
          .select({ c: sql<number>`count(*)::int` })
          .from(users)
          .where(gte(users.riskTier, 1));
        return { count: rows[0]?.c ?? 0 };
      } catch {
        return { count: null };
      }
    })(),
    (async () => {
      try {
        const rows = await db.query.auditLogs.findMany({
          orderBy: [desc(auditLogs.createdAt)],
          limit: 5,
          columns: { id: true, action: true, createdAt: true },
        });
        return {
          rows: rows.map((r) => ({
            id: r.id,
            action: r.action,
            createdAt: r.createdAt.toISOString(),
          })),
          error: false,
        };
      } catch {
        return { rows: [], error: true };
      }
    })(),
  ]);
  return {
    circuit,
    riskTierQueue: riskCount,
    recentAudit: audit,
  };
}

type OverviewCard = {
  href: string;
  /** i18n key under `admin.overview.*Card` */
  cardKey:
    | 'aiBreakerCard'
    | 'assistantCard'
    | 'riskTierCard'
    | 'aiWorkspaceAccessCard'
    | 'revalidationCard'
    | 'licenseCard'
    | 'licenseRevokeCard'
    | 'issuedLicensesCard'
    | 'ssoCard'
    | 'vocabCard';
  show: boolean;
  /** true → 卡片显示 "Coming soon" 徽章 + 禁用链接 */
  comingSoon: boolean;
};

const CARDS: ReadonlyArray<OverviewCard> = [
  {
    href: '/admin/assistant',
    cardKey: 'assistantCard',
    show: true,
    comingSoon: false,
  },
  {
    href: '/admin/ai-circuit-breaker',
    cardKey: 'aiBreakerCard',
    show: true,
    comingSoon: false,
  },
  {
    href: '/admin/ai-workspace-access',
    cardKey: 'aiWorkspaceAccessCard',
    show: true,
    comingSoon: false,
  },
  {
    href: '/admin/revalidation',
    cardKey: 'revalidationCard',
    show: true,
    comingSoon: false,
  },
  {
    href: '/admin/domain-vocabularies',
    cardKey: 'vocabCard',
    show: true,
    comingSoon: false,
  },
  {
    href: '/admin/risk-tier',
    cardKey: 'riskTierCard',
    show: CAN_RISKTIER,
    comingSoon: false,
  },
  {
    href: '/admin/license',
    cardKey: 'licenseCard',
    show: CAN_LICENSE,
    comingSoon: false, // PR-8 落地
  },
  // SaaS-only ops surfaces — Aster team uses these to revoke
  // customer licenses and inspect the full ledger of issued licenses.
  {
    href: '/admin/license-revoke',
    cardKey: 'licenseRevokeCard',
    show: IS_SAAS,
    comingSoon: false,
  },
  {
    href: '/admin/issued-licenses',
    cardKey: 'issuedLicensesCard',
    show: IS_SAAS,
    comingSoon: false,
  },
  {
    href: '/admin/sso',
    cardKey: 'ssoCard',
    show: CAN_SSO,
    comingSoon: false, // PR-8 落地
  },
];

export default async function AdminOverviewPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations('admin.overview');
  const tPulse = await getTranslations('admin.pulse');
  const tEvents = await getTranslations('admin.pulse.audit.events');
  const cards = CARDS.filter((c) => c.show);
  const pulse = await loadPulse();

  return (
    <Container size="xl" className="py-6 sm:py-10">
      {/* 顶层页：sidebar 已高亮 "Admin" + PageHeader h1 显页名 → 不再放 Breadcrumbs（去三重重复）。 */}
      <PageHeader title={t('title')} subtitle={t('subtitle')} className="mb-6" />

      <div className="space-y-8">
      {/* Admin Pulse — first viewport health signals. Each card is
          independent: if one fails to load, the others still render. */}
      <section aria-labelledby="admin-pulse-heading">
        <h2
          id="admin-pulse-heading"
          className="mb-3 text-sm font-semibold uppercase tracking-wider text-fg-muted"
        >
          {tPulse('heading')}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <PulseCircuitCard
            state={pulse.circuit.state}
            todayUsd={pulse.circuit.todayUsd}
            labels={{
              title: tPulse('circuit.title'),
              healthy: tPulse('circuit.healthy'),
              tripped: tPulse('circuit.tripped'),
              error: tPulse('circuit.error'),
              spendToday: tPulse('circuit.spendToday'),
            }}
            href="/admin/ai-circuit-breaker"
          />
          {CAN_RISKTIER && (
            <PulseRiskTierCard
              count={pulse.riskTierQueue.count}
              labels={{
                title: tPulse('riskTier.title'),
                empty: tPulse('riskTier.empty'),
                count: tPulse('riskTier.count'),
                error: tPulse('riskTier.error'),
              }}
              href="/admin/risk-tier"
            />
          )}
          <PulseAuditCard
            rows={pulse.recentAudit.rows.map((r) => ({
              ...r,
              // 原始 id 对管理员不友好：映射为本地化事件名，日期用全站统一的 formatDate。
              label: adminEventLabel(r.action, (key) => tEvents(key)),
              date: formatDate(r.createdAt, locale),
            }))}
            errored={pulse.recentAudit.error}
            labels={{
              title: tPulse('audit.title'),
              empty: tPulse('audit.empty'),
              error: tPulse('audit.error'),
            }}
          />
        </div>
      </section>

      {/* Platform controls — admin-controlled platform toggles (feature
          flags + language availability). Lives between Admin Pulse and the
          Tools section so a SaaS admin can flip a switch without scrolling
          past the day-to-day control surfaces. */}
      <section aria-labelledby="admin-controls-heading">
        <h2
          id="admin-controls-heading"
          className="mb-3 text-sm font-semibold uppercase tracking-wider text-fg-muted"
        >
          {t('controlsHeading')}
        </h2>
        <div className="grid gap-4">
          <FeatureFlagsCard />
          <RunnerParityCard />
          <PlatformLanguageCard />
          <ByokAllowlistCard />
          <StructuralAliasGrantsCard />
        </div>
      </section>

      <section aria-labelledby="admin-overview-tools-heading">
        <h2
          id="admin-overview-tools-heading"
          className="mb-3 text-sm font-semibold uppercase tracking-wider text-fg-muted"
        >
          {t('cardsHeading')}
        </h2>
        <ul
          role="list"
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {cards.map((card) => (
            <OverviewCardItem
              key={card.href}
              href={card.href}
              title={t(`${card.cardKey}.title`)}
              description={t(`${card.cardKey}.description`)}
              cta={t(`${card.cardKey}.cta`)}
              comingSoonLabel={
                card.comingSoon
                  ? t(`${card.cardKey}.comingSoon` as 'licenseCard.comingSoon')
                  : null
              }
            />
          ))}
        </ul>
      </section>
      </div>
    </Container>
  );
}

/* ------------------------------------------------------------------ */
/* Pulse card components                                                */
/* ------------------------------------------------------------------ */

function PulseCard({
  title,
  href,
  tone,
  children,
}: {
  title: string;
  href?: string;
  tone: 'ok' | 'warn' | 'error' | 'neutral';
  children: React.ReactNode;
}) {
  const toneClass = {
    ok: 'border-success/30 bg-success-subtle',
    warn: 'border-warning/30 bg-warning-subtle',
    error: 'border-danger/30 bg-danger-subtle',
    neutral: 'border-border bg-bg',
  }[tone];
  const inner = (
    <article
      className={`flex h-full flex-col rounded-lg border p-4 ${toneClass}`}
    >
      <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
        {title}
      </h3>
      <div className="mt-2 flex-1">{children}</div>
    </article>
  );
  if (!href) return inner;
  return (
    <Link
      href={href}
      className="block transition-shadow hover:shadow-md focus-visible:shadow-md focus-visible:outline-none"
    >
      {inner}
    </Link>
  );
}

function PulseCircuitCard({
  state,
  todayUsd,
  labels,
  href,
}: {
  state: CircuitPulseState;
  todayUsd: string | null;
  labels: {
    title: string;
    healthy: string;
    tripped: string;
    error: string;
    spendToday: string;
  };
  href: string;
}) {
  // 'closed' = healthy (circuit is closed, traffic flowing normally).
  // 'free_stopped' / 'free_trial_stopped' = tripped at one of the
  // platform-cost thresholds. 'error' = state lookup itself failed.
  const tripped = state === 'free_stopped' || state === 'free_trial_stopped';
  const tone: 'ok' | 'warn' | 'error' =
    state === 'error' ? 'error' : tripped ? 'warn' : 'ok';
  const label =
    state === 'error'
      ? labels.error
      : tripped
        ? labels.tripped
        : labels.healthy;
  return (
    <PulseCard title={labels.title} tone={tone} href={href}>
      <p className="text-lg font-semibold text-fg">{label}</p>
      {todayUsd !== null && (
        <p className="mt-1 text-xs text-fg-muted">
          {labels.spendToday}: ${todayUsd}
        </p>
      )}
    </PulseCard>
  );
}

function PulseRiskTierCard({
  count,
  labels,
  href,
}: {
  count: number | null;
  labels: { title: string; empty: string; count: string; error: string };
  href: string;
}) {
  if (count === null) {
    return (
      <PulseCard title={labels.title} tone="error" href={href}>
        <p className="text-sm text-fg">{labels.error}</p>
      </PulseCard>
    );
  }
  if (count === 0) {
    return (
      <PulseCard title={labels.title} tone="ok" href={href}>
        <p className="text-lg font-semibold text-fg">{labels.empty}</p>
      </PulseCard>
    );
  }
  return (
    <PulseCard title={labels.title} tone="warn" href={href}>
      <p className="text-2xl font-semibold text-fg tabular-nums">{count}</p>
      <p className="mt-1 text-xs text-fg-muted">{labels.count}</p>
    </PulseCard>
  );
}

function PulseAuditCard({
  rows,
  errored,
  labels,
}: {
  rows: Array<PulseSignals['recentAudit']['rows'][number] & { label: string; date: string }>;
  errored: boolean;
  labels: { title: string; empty: string; error: string };
}) {
  if (errored) {
    return (
      <PulseCard title={labels.title} tone="error">
        <p className="text-sm text-fg">{labels.error}</p>
      </PulseCard>
    );
  }
  if (rows.length === 0) {
    return (
      <PulseCard title={labels.title} tone="neutral">
        <p className="text-sm text-fg-muted">{labels.empty}</p>
      </PulseCard>
    );
  }
  return (
    <PulseCard title={labels.title} tone="neutral">
      <ul className="space-y-1 text-xs">
        {rows.slice(0, 3).map((r) => (
          <li key={r.id} className="flex items-baseline justify-between gap-2">
            <span className="truncate text-fg" title={r.action}>
              {r.label}
            </span>
            <span className="shrink-0 text-fg-subtle">{r.date}</span>
          </li>
        ))}
      </ul>
    </PulseCard>
  );
}

function OverviewCardItem({
  href,
  title,
  description,
  cta,
  comingSoonLabel,
}: {
  href: string;
  title: string;
  description: string;
  cta: string;
  comingSoonLabel: string | null;
}) {
  const disabled = comingSoonLabel != null;

  // 用 <li> 包 <Link> 让 role="list" 的 grid 项目语义正确；
  // 禁用状态用 aria-disabled 而不是删 href，保持视觉一致
  return (
    <li className="h-full">
      <article
        className={[
          'flex h-full flex-col rounded-lg border border-border bg-bg p-5 transition-shadow',
          disabled
            ? 'opacity-70'
            : 'hover:shadow-md focus-within:shadow-md',
        ].join(' ')}
      >
        <div className="mb-2 flex items-start justify-between gap-2">
          <h3 className="text-base font-semibold text-fg">{title}</h3>
          {comingSoonLabel && (
            <span className="inline-flex items-center rounded bg-bg-subtle px-2 py-0.5 text-xs font-medium text-fg-muted">
              {comingSoonLabel}
            </span>
          )}
        </div>
        <p className="text-sm text-fg-muted">{description}</p>
        <div className="mt-4 pt-4 border-t border-border text-sm">
          {disabled ? (
            <span
              aria-disabled="true"
              className="text-fg-muted"
            >
              {cta}
            </span>
          ) : (
            <Link
              href={href}
              className="font-medium text-primary hover:underline focus:underline focus:outline-none"
            >
              {cta} →
            </Link>
          )}
        </div>
      </article>
    </li>
  );
}
