// /billing — admin billing overview.
//
// Was a direct plan picker pre P1-2; the plan picker moved to
// /billing/plans. This page now answers an admin's first question:
// "what's the state of my account billing?" — plan, trial countdown,
// usage caps, seat allocation, and a link into the Stripe Customer
// Portal for full invoice history + payment method changes.
//
// We deliberately don't render a custom invoice list here. Stripe's
// hosted portal already does that (with refunds / disputes / receipt
// downloads) and pulling the same data into our UI would duplicate
// state without adding value. The "Manage in Stripe" link below is
// the single source of truth for invoice ops.

import { getTranslations, getLocale } from 'next-intl/server';
import { notFound, redirect } from 'next/navigation';
import { eq, sql, and } from 'drizzle-orm';
import { Link } from '@/i18n/navigation';
import { getSession } from '@/lib/auth';
import { getUsageStats } from '@/lib/usage';
import { countOwnerPoolUsage, currentPeriodMonth } from '@/lib/api-quota-pool';
import { CAN_BILLING } from '@/lib/deployment-mode';
import {
  formatPrice,
  getCurrencyForLocale,
  getPlanPrice,
  isUnlimited,
  PLANS,
  type PlanType,
  type CurrencyCode,
} from '@/lib/plans';
import { db, teams, teamMembers } from '@/lib/prisma';
import {
  buttonVariants,
  Card,
  CardBody,
  Container,
  PageHeader,
  Stack,
  cn,
} from '@/components/ui';

export default async function BillingOverviewPage() {
  // On-prem 没有 Stripe — overview 同样不存在。
  if (!CAN_BILLING) {
    notFound();
  }

  const session = await getSession();
  if (!session?.user?.id) {
    redirect('/login');
  }

  const t = await getTranslations('billing');
  const tOv = await getTranslations('billing.overview');
  const locale = await getLocale();
  const currency = getCurrencyForLocale(locale) as CurrencyCode;
  const userId = session.user.id;

  const [usageStats, policyApiCalls] = await Promise.all([
    getUsageStats(userId),
    loadPolicyApiCalls(userId),
  ]);
  const planType = (usageStats.plan || 'free') as PlanType;
  const planDef = PLANS[planType];

  // Trial countdown: session.user.trialEndsAt is the source of truth
  // (set by auth.createUser on signup, refreshed by the jwt callback).
  const trialEndsAtRaw = session.user.trialEndsAt
    ? new Date(session.user.trialEndsAt)
    : null;
  // Server Component 每请求只渲染一次，Date.now() 在此渲染安全（非客户端重渲染）
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const trialDaysLeft = trialEndsAtRaw
    ? Math.max(
        0,
        Math.ceil((trialEndsAtRaw.getTime() - now) / (24 * 60 * 60 * 1000)),
      )
    : null;
  const isTrial = planType === 'trial' || (trialDaysLeft !== null && trialDaysLeft > 0);

  // Seats: count teams the user owns, then sum members across those
  // teams. SaaS plans cap seats via PLANS[plan].limits; below the cap
  // is the user-facing "X of Y used" number.
  const [seatRows] = await Promise.all([
    db
      .select({ c: sql<number>`count(*)::int` })
      .from(teamMembers)
      .innerJoin(teams, eq(teamMembers.teamId, teams.id))
      .where(and(eq(teams.ownerId, userId))),
  ]);
  const seatsUsed = seatRows[0]?.c ?? 1;
  // seatLimit === null → "unlimited" for display (the plan cap is
  // -1 in the schema). Free tier caps at 1 so the user always sees
  // either a real number ("1 of 1") or no cap.
  const rawSeatLimit = planDef.limits?.teamMembers;
  const seatLimit =
    rawSeatLimit === undefined || isUnlimited(rawSeatLimit)
      ? null
      : rawSeatLimit;

  // Format a sample "next invoice" price using PLANS pricing. Real
  // next-invoice amount lives on Stripe; the card just gives a
  // ballpark + a portal link for accuracy.
  //
  // Enterprise plans return null monthly (custom-priced) — surface
  // that as a "contact sales" hint via planPriceDisplay === null.
  // Free / trial tiers price at 0.
  const monthly =
    planType === 'free' ? 0 : getPlanPrice(planType, currency).monthly;
  const planPriceDisplay =
    monthly === null ? null : formatPrice(monthly, currency);

  // Helper to interpolate i18n templates like '{used} of {limit} used'.
  const tpl = (key: string, values: Record<string, string | number>) =>
    tOv(key).replace(/\{(\w+)\}/g, (_, k) => String(values[k] ?? ''));

  return (
    <Container size="xl" className="py-6 sm:py-10">
      <Stack gap={8}>
        {/* 顶层页：去 Breadcrumbs（sidebar 高亮 + PageHeader h1 已显页名）。 */}
        <PageHeader
          title={tOv('overviewTitle')}
          subtitle={tOv('overviewSubtitle')}
        />

        {/* Row 1: Plan / Trial / Next invoice */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <OverviewCard title={tOv('planCardTitle')}>
            <p className="font-display text-2xl font-semibold tracking-tight text-fg">
              {t(`plans.names.${planType}`)}
            </p>
            <p className="mt-1 text-sm text-fg-muted">
              {isTrial ? tOv('planTrial').replace('{plan}', '') : tOv('planActive')}
            </p>
          </OverviewCard>

          <OverviewCard title="Trial">
            {trialDaysLeft !== null && trialDaysLeft > 0 ? (
              <p className="font-display text-2xl font-semibold tracking-tight text-fg">
                {tpl('trialDaysLeft', { days: trialDaysLeft })}
              </p>
            ) : (
              <p className="text-sm text-fg-muted">{tOv('trialNoActive')}</p>
            )}
          </OverviewCard>

          <OverviewCard title={tOv('nextInvoiceTitle')}>
            {planType === 'free' ? (
              <p className="text-sm text-fg-muted">—</p>
            ) : planPriceDisplay === null ? (
              <p className="text-sm text-fg-muted">{t('contactSales')}</p>
            ) : monthly && monthly > 0 ? (
              <>
                <p className="font-display text-2xl font-semibold tracking-tight text-fg">
                  {planPriceDisplay}
                </p>
                <p className="mt-1 text-sm text-fg-muted">{t('month')}</p>
              </>
            ) : (
              <p className="text-sm text-fg-muted">
                {tOv('nextInvoicePending')}
              </p>
            )}
          </OverviewCard>
        </div>

        {/* Row 2: Usage + Seats */}
        <div className="grid gap-4 lg:grid-cols-2">
          <OverviewCard title={tOv('usageTitle')}>
            <Stack gap={2}>
              <UsageRow
                label={t('executionsThisMonth')}
                used={usageStats.usage.executions}
                limit={usageStats.usage.executionsLimit}
              />
              {/* 两个独立计量各自成行并分别命名：cloud REST 调用（UsageRecord）与 Policy 执行 API（ApiCallRecord 配额池），
                  二者共用套餐的 apiCalls 上限值但分别计数，混用「API 调用」一个名字会看似互相矛盾 */}
              {policyApiCalls !== null && (
                <UsageRow
                  label={t('policyApiCallsThisMonth')}
                  used={policyApiCalls}
                  limit={usageStats.usage.apiCallsLimit}
                />
              )}
              <UsageRow
                label={t('restApiCallsThisMonth')}
                used={usageStats.usage.apiCalls}
                limit={usageStats.usage.apiCallsLimit}
              />
              <UsageRow
                label={t('savedPolicies')}
                used={usageStats.usage.policies}
                limit={usageStats.usage.policiesLimit}
              />
            </Stack>
          </OverviewCard>

          <OverviewCard title={tOv('seatsTitle')}>
            <Stack gap={3}>
              <p className="font-display text-2xl font-semibold tracking-tight text-fg">
                {seatLimit !== null
                  ? tpl('seatsUsedTemplate', { used: seatsUsed, limit: seatLimit })
                  : seatsUsed}
              </p>
              <Link
                href="/teams"
                className={buttonVariants({ variant: 'secondary', size: 'sm' })}
              >
                {tOv('seatsInvite')}
              </Link>
            </Stack>
          </OverviewCard>
        </div>

        {/* Row 3: Invoices stub + actions */}
        <Card>
          <CardBody className="pt-6">
            <Stack
              direction="row"
              justify="between"
              align="center"
              gap={4}
              wrap
            >
              <Stack gap={1} className="min-w-0 flex-1">
                <h2 className="font-display text-xl font-semibold tracking-tight text-fg">
                  {tOv('invoicesTitle')}
                </h2>
                <p className="text-sm text-fg-muted">
                  {tOv('managePayment')} · {tOv('invoicesEmpty')}
                </p>
              </Stack>
              <Stack direction="row" gap={3} className="shrink-0">
                {/* Stripe Customer Portal session API at
                    /api/stripe/portal accepts POST only (mints a
                    one-shot session URL then 302s into Stripe's
                    hosted portal). Wrap a button in a <form> with
                    method="post" so the click triggers a POST without
                    needing client JS. The Next.js lint rule against
                    bare <a href="/api/…"> is satisfied because the
                    form action is the submission target, not an <a>. */}
                <form action="/api/stripe/portal" method="post">
                  <button
                    type="submit"
                    className={buttonVariants({
                      variant: 'secondary',
                      size: 'md',
                    })}
                  >
                    {tOv('managePayment')}
                  </button>
                </form>
                <Link
                  href="/billing/plans"
                  className={buttonVariants({ variant: 'primary', size: 'md' })}
                >
                  {tOv('changePlan')} →
                </Link>
              </Stack>
            </Stack>
          </CardBody>
        </Card>
      </Stack>
    </Container>
  );
}

/* ------------------------------------------------------------------ */
/* Subcomponents                                                       */
/* ------------------------------------------------------------------ */

function OverviewCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardBody className="pt-6">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
          {title}
        </h3>
        <div className="mt-2">{children}</div>
      </CardBody>
    </Card>
  );
}

/**
 * 本月 Policy 执行 API 调用量（owner 配额池，与 dashboard 用量卡片、aster-api 限流同一口径）。
 * 查询失败（如 ApiCallRecord 迁移未落地）返回 null，概览页隐藏该行而不是整页报错。
 */
async function loadPolicyApiCalls(userId: string): Promise<number | null> {
  try {
    return await countOwnerPoolUsage(userId, currentPeriodMonth());
  } catch (error) {
    console.error('[billing] policy api usage unavailable', error);
    return null;
  }
}

function UsageRow({
  label,
  used,
  limit,
}: {
  label: string;
  used: number;
  limit: number;
}) {
  const limitText = isUnlimited(limit) ? '∞' : limit.toLocaleString();
  const usedText = used.toLocaleString();
  const pct = !isUnlimited(limit) && limit > 0
    ? Math.min(100, Math.round((used / limit) * 100))
    : 0;
  return (
    <div>
      <Stack direction="row" justify="between" align="baseline" gap={3}>
        <p className="text-sm font-medium text-fg">{label}</p>
        <p className="font-mono text-xs text-fg-muted">
          {usedText} / {limitText}
        </p>
      </Stack>
      {!isUnlimited(limit) && limit > 0 && (
        <div className="mt-1 h-1 overflow-hidden rounded bg-bg-subtle">
          <div
            className={cn(
              'h-full bg-primary transition-[width]',
              pct >= 90 && 'bg-danger',
              pct >= 70 && pct < 90 && 'bg-warning',
            )}
            style={{ width: `${pct}%` }}
            aria-hidden
          />
        </div>
      )}
    </div>
  );
}
