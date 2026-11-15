/**
 * /equivalence 首屏三层：结论（Hero）→ 三个一致率维度卡片 → 覆盖率进度条。
 *
 * 结论先行：访客第一眼得到「两个引擎是否一致 + 何时检查的」，细节逐层展开。
 * 所有状态（一致 / 分歧 / 过期 / 无数据 / 回退）由 summarizeParity 纯函数判定，
 * 这里只负责呈现；状态一律有文字表达，不只靠颜色或图标。
 */
import { getTranslations } from 'next-intl/server';
import { AlertTriangle, CheckCircle2, Clock, TrendingDown, XCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle, Badge, Card, CardBody, Container, EmptyState, cn } from '@/components/ui';
import {
  AGREEMENT_DIMENSIONS,
  COVERAGE_DIMENSIONS,
  type DimensionStatus,
  type ParitySummary,
} from '@/lib/equivalence/parity';
import { PARITY_REPO_URL } from '@/lib/equivalence/fetch';
import { formatParityDate, formatParityRate } from '@/lib/equivalence/format';

type SectionProps = { summary: ParitySummary; locale: string };
type Translator = Awaited<ReturnType<typeof getTranslations<'equivalencePage'>>>;

export async function ParityVerdict({ summary, locale }: SectionProps) {
  const t = await getTranslations('equivalencePage');
  const diverged = summary.verdict === 'diverged';
  const partial = summary.verdict === 'partial';
  const missingNames = summary.missing.map((d) => t(`dimensions.${d}.title`)).join(', ');

  return (
    <section className="relative overflow-hidden pt-16 pb-12 sm:pt-20" aria-labelledby="parity-verdict">
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 -z-10 h-[28rem] bg-[radial-gradient(ellipse_60%_50%_at_50%_0%,var(--aster-color-violet-100),transparent_60%)] dark:opacity-30"
      />
      <Container size="base">
        <div className="flex flex-col items-center gap-5 text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-primary">{t('hero.title')}</p>

          {summary.verdict === 'empty' ? (
            <>
              <h1 id="parity-verdict" className="font-display text-[clamp(1.75rem,4.5vw,2.75rem)] font-semibold leading-tight tracking-tight text-fg">
                {t('verdict.empty')}
              </h1>
              <EmptyState
                className="w-full"
                icon={<AlertTriangle className="size-6 text-warning" aria-hidden />}
                title={t('verdict.emptyTitle')}
                description={t('verdict.emptyBody')}
                action={
                  <a href={PARITY_REPO_URL} className="text-sm font-medium text-primary hover:text-primary-hover">
                    {t('verdict.emptyLink')} <span aria-hidden>→</span>
                  </a>
                }
              />
            </>
          ) : (
            <>
              <Badge variant={diverged ? 'danger' : partial ? 'warning' : 'success'} className="gap-1.5 px-3 py-1 text-sm">
                {diverged ? (
                  <XCircle className="size-4" aria-hidden />
                ) : partial ? (
                  <AlertTriangle className="size-4" aria-hidden />
                ) : (
                  <CheckCircle2 className="size-4" aria-hidden />
                )}
                {diverged ? t('verdict.statusDiverged') : partial ? t('verdict.statusPartial') : t('verdict.statusAgree')}
              </Badge>
              <h1
                id="parity-verdict"
                className="text-balance font-display text-[clamp(1.75rem,4.5vw,3rem)] font-semibold leading-[1.1] tracking-tight text-fg"
              >
                {diverged
                  ? t('verdict.diverged', { count: summary.divergentChecks, total: summary.totalChecks })
                  : partial
                    ? t('verdict.partial', { count: summary.totalChecks })
                    : t('verdict.agree', { count: summary.totalChecks })}
              </h1>
              <p className="max-w-2xl text-lg leading-relaxed text-fg-muted">{t('verdict.lead')}</p>
              {summary.lastChecked && (
                <p className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-sm text-fg-muted">
                  <span className="inline-flex items-center gap-1.5 font-medium text-fg">
                    <Clock className="size-4 text-fg-subtle" aria-hidden />
                    {t('verdict.lastChecked', { date: formatParityDate(summary.lastChecked, locale) })}
                  </span>
                  <span aria-hidden className="hidden text-fg-subtle sm:inline">·</span>
                  <span>{t('verdict.schedule')}</span>
                </p>
              )}
              {diverged && (
                <a href="#divergences" className="text-sm font-medium text-danger underline underline-offset-4">
                  {t('verdict.seeDivergences')}
                </a>
              )}
            </>
          )}

          {partial && (
            <Alert variant="warning" className="text-left">
              <div>
                <AlertTitle>{t('verdict.partialTitle')}</AlertTitle>
                <AlertDescription>{t('verdict.partialBody', { dimensions: missingNames })}</AlertDescription>
              </div>
            </Alert>
          )}

          {summary.stale && summary.staleAgeDays != null && (
            <Alert variant="warning" className="text-left">
              <div>
                <AlertTitle>{t('verdict.staleTitle')}</AlertTitle>
                <AlertDescription>{t('verdict.staleBody', {
                    days: summary.staleAgeDays,
                    dimensions: summary.staleDimensions.map((d) => t(`dimensions.${d}.title`)).join(', '),
                  })}</AlertDescription>
              </div>
            </Alert>
          )}
        </div>
      </Container>
    </section>
  );
}

/** 卡片底部的一行状态：回退 > 过期 > 测量日期落后 > 覆盖范围增长（只显示最重要的一条）。 */
function StatusLine({
  t,
  status,
  locale,
  kind,
  lastChecked,
}: {
  t: Translator;
  status: DimensionStatus;
  locale: string;
  kind: 'dimensions' | 'coverage';
  lastChecked: string | null;
}) {
  const { latest, previous, first } = status;
  if (!latest) return null;
  if (status.regressed && previous) {
    return (
      <p className="flex items-center gap-1.5 text-xs font-medium text-danger">
        <TrendingDown className="size-3.5 shrink-0" aria-hidden />
        {t(`${kind}.regressed`, {
          rate: formatParityRate(previous.rate, locale),
          date: formatParityDate(previous.timestamp, locale),
        })}
      </p>
    );
  }
  if (status.stale) {
    return (
      <p className="flex items-center gap-1.5 text-xs font-medium text-warning">
        <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
        {t('dimensions.staleNote', { date: formatParityDate(latest.timestamp, locale) })}
      </p>
    );
  }
  // 各维度最新测量不一定同一天：落后于结论日期的维度单独标出测量日期，避免被误读为同一次运行。
  if (lastChecked && latest.timestamp.slice(0, 10) !== lastChecked.slice(0, 10)) {
    return (
      <p className="text-xs text-fg-subtle">{t('dimensions.staleNote', { date: formatParityDate(latest.timestamp, locale) })}</p>
    );
  }
  if (kind === 'dimensions' && first && first.total < latest.total) {
    return (
      <p className="text-xs text-fg-subtle">
        {t('dimensions.growth', { count: first.total, date: formatParityDate(first.timestamp, locale) })}
      </p>
    );
  }
  return null;
}

export async function AgreementCards({ summary, locale }: SectionProps) {
  const t = await getTranslations('equivalencePage');
  const nf = new Intl.NumberFormat(locale);

  return (
    <section className="border-y border-border bg-bg-subtle py-14" aria-labelledby="parity-dimensions">
      <Container size="wide">
        <div className="mb-8 max-w-2xl space-y-2">
          <h2 id="parity-dimensions" className="font-display text-2xl font-semibold tracking-tight">
            {t('dimensions.heading')}
          </h2>
          <p className="text-sm leading-relaxed text-fg-muted">{t('dimensions.intro')}</p>
        </div>
        <ul className="grid gap-4 md:grid-cols-3">
          {AGREEMENT_DIMENSIONS.map((dim) => {
            const status = summary.agreement[dim];
            const { latest } = status;
            const diverged = status.gap > 0;
            return (
              <li key={dim}>
                <Card className={cn('h-full', diverged && 'border-danger')}>
                  <CardBody className="flex h-full flex-col gap-3">
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="font-display text-lg font-semibold tracking-tight">{t(`dimensions.${dim}.title`)}</h3>
                      {latest && (
                        <Badge variant={diverged ? 'danger' : 'success'} className="shrink-0">
                          {diverged ? t('dimensions.badgeDiverged', { count: status.gap }) : t('dimensions.badgeAgree')}
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm leading-relaxed text-fg-muted">{t(`dimensions.${dim}.body`)}</p>
                    <div className="mt-auto pt-2">
                      {latest ? (
                        <>
                          <p className="font-display text-3xl font-semibold tabular-nums tracking-tight text-fg">
                            {nf.format(latest.value)}
                            <span className="text-fg-subtle"> / {nf.format(latest.total)}</span>
                          </p>
                          <p className="text-sm text-fg-muted">
                            {t(`dimensions.${dim}.unit`)} · {formatParityRate(latest.rate, locale)}
                          </p>
                        </>
                      ) : (
                        <p className="text-sm text-fg-subtle">{t('dimensions.noData')}</p>
                      )}
                    </div>
                    <StatusLine t={t} lastChecked={summary.lastChecked} status={status} locale={locale} kind="dimensions" />
                  </CardBody>
                </Card>
              </li>
            );
          })}
        </ul>
      </Container>
    </section>
  );
}

export async function CoverageMeters({ summary, locale }: SectionProps) {
  const t = await getTranslations('equivalencePage');
  const nf = new Intl.NumberFormat(locale);

  return (
    <section className="py-14" aria-labelledby="parity-coverage">
      <Container size="wide">
        <div className="grid gap-8 lg:grid-cols-[1fr_1.4fr] lg:items-start">
          <div className="space-y-2">
            <h2 id="parity-coverage" className="font-display text-2xl font-semibold tracking-tight">
              {t('coverage.heading')}
            </h2>
            <p className="text-sm leading-relaxed text-fg-muted">{t('coverage.intro')}</p>
          </div>
          <Card>
            <CardBody className="space-y-6">
              {COVERAGE_DIMENSIONS.map((dim) => {
                const status = summary.coverage[dim];
                const { latest } = status;
                const pct = latest ? Math.round(latest.rate * 1000) / 10 : 0;
                return (
                  <div key={dim} className="space-y-2">
                    <div className="flex items-baseline justify-between gap-3">
                      <h3 id={`coverage-${dim}`} className="text-sm font-semibold text-fg">
                        {t(`coverage.${dim}.title`)}
                      </h3>
                      <span className="font-display text-xl font-semibold tabular-nums">
                        {latest ? formatParityRate(latest.rate, locale) : '—'}
                      </span>
                    </div>
                    <div
                      role="meter"
                      aria-labelledby={`coverage-${dim}`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={pct}
                      className="h-2 overflow-hidden rounded-full bg-bg-muted"
                    >
                      <div className={cn('h-full rounded-full', status.regressed ? 'bg-danger' : 'bg-success')} style={{ width: `${pct}%` }} />
                    </div>
                    <p className="text-xs text-fg-muted">
                      {latest
                        ? t(`coverage.${dim}.detail`, { value: nf.format(latest.value), total: nf.format(latest.total) })
                        : t('dimensions.noData')}
                      {' — '}
                      {t(`coverage.${dim}.body`)}
                    </p>
                    <StatusLine t={t} lastChecked={summary.lastChecked} status={status} locale={locale} kind="coverage" />
                  </div>
                );
              })}
            </CardBody>
          </Card>
        </div>
      </Container>
    </section>
  );
}
