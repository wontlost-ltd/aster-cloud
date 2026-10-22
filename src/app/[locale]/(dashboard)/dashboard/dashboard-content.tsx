/**
 * Dashboard home — the first thing every signed-in user sees.
 *
 * W2.3 rewrite goals (compared to the 463-line predecessor):
 *   - All inline indigo/green/purple/yellow/red utilities replaced with
 *     design-system primitives and semantic tokens
 *   - Repeated stat-card and quick-action patterns extracted to local
 *     subcomponents so the JSX reads as "5 stat cards, 3 quick actions"
 *     instead of 100 lines of copy-paste
 *   - Card + Stack + Container layout so density and spacing match the
 *     rest of the W2 sweep
 *
 * Behaviors preserved verbatim:
 *   - Trial / plan banner switch
 *   - PII badge
 *   - Usage progress bars when limits are finite
 *   - DunningBanner, AhaStatusCard, AiUsageCard, ApiUsageCard all
 *     mounted in their original slots
 */
'use client';

import {
  Plus,
  FileText,
  KeyRound,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { CLIENT_CAPABILITIES } from '@/hooks/use-deployment-mode';
import { isUnlimited } from '@/lib/plans';
import { AiUsageCard } from '@/components/dashboard/ai-usage-card';
import { ApiUsageCard } from '@/components/dashboard/api-usage-card';
import { AhaStatusCard } from '@/components/dashboard/aha-status-card';
import { DunningBanner } from '@/components/dashboard/dunning-banner';
import {
  AdminLaunchpad,
  type SetupSignals,
  type LaunchpadTranslations,
} from '@/components/dashboard/admin-launchpad';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  buttonVariants,
  Card,
  CardBody,
  Container,
  PageHeader,
  Stack,
  cn,
} from '@/components/ui';

/* ------------------------------------------------------------------ */
/* Types — props shape unchanged from the previous version             */
/* ------------------------------------------------------------------ */

interface DashboardStats {
  plan: string;
  trialDaysLeft: number | null;
  usage: {
    executions: number;
    executionsLimit: number;
    policies: number;
    policiesLimit: number;
    piiScans: number;
    evidenceExports: number;
    apiCalls: number;
    apiCallsLimit: number;
  };
  features: {
    piiDetection: string;
    sharing: boolean;
    evidenceExport: boolean;
    apiAccess: boolean;
    teamFeatures: boolean;
  };
}

interface Policy {
  id: string;
  name: string;
  description: string | null;
  piiFields: string[] | null;
  updatedAt: string;
  _count: { executions: number };
}

interface Translations {
  welcomeBack: string;
  newPolicy: string;
  trialActive: string;
  trialDaysLeft: string;
  upgradeNow: string;
  toKeepProFeatures: string;
  planActive: string;
  stats: {
    totalPolicies: string;
    executionsThisMonth: string;
    apiCalls: string;
    piiFieldsDetected: string;
    limitTemplate: string;
    upgradeForApi: string;
    reviewRecommended: string;
  };
  quickActions: {
    title: string;
    createPolicy: string;
    createPolicyDesc: string;
    generateReport: string;
    generateReportDesc: string;
    apiKeys: string;
    apiKeysDesc: string;
  };
  recentPolicies: {
    title: string;
    viewAll: string;
    noPolicies: string;
    createFirst: string;
    noDescription: string;
    runsTemplate: string;
  };
}

interface DashboardContentProps {
  stats: DashboardStats;
  policies: Policy[];
  /**
   * Admin launchpad — only rendered when the viewer is an admin AND
   * the checklist still has outstanding steps. Driven by JWT-side
   * `isAdmin` + four DB-side signal counts; component hides itself
   * when complete or dismissed (localStorage flag).
   */
  isAdmin: boolean;
  setupSignals: SetupSignals;
  launchpadTranslations: LaunchpadTranslations;
  totalPiiFields: number;
  translations: Translations;
  locale: string;
}

/** Tiny template interpolator — replaces {count}/{plan}/etc. in i18n
 *  strings whose plurals are computed server-side. Kept inline so the
 *  dependency on next-intl's ICU API stays minimal. */
function formatTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
}

/* ------------------------------------------------------------------ */
/* Root component                                                      */
/* ------------------------------------------------------------------ */

export function DashboardContent({
  stats,
  policies,
  isAdmin,
  setupSignals,
  launchpadTranslations,
  totalPiiFields,
  translations: t,
  locale,
}: DashboardContentProps) {
  return (
    <Container size="xl" className="py-6 sm:py-10">
      <Stack gap={8}>
        <DunningBanner />

        {/* Welcome row + primary CTA — 顶层页：sidebar 已高亮 "Dashboard"
            + PageHeader h1 显页名 → 不放 Breadcrumbs（去三重重复）。 */}
        <PageHeader
          title={t.welcomeBack}
          action={
            <Link
              href="/policies/new"
              className={buttonVariants({ variant: 'primary', size: 'md' })}
            >
              <Plus className="size-4" aria-hidden />
              {t.newPolicy}
            </Link>
          }
        />

        {/* Admin setup launchpad — first viewport for SaaS admins on a
            fresh tenant. The component self-hides when all five signals
            are satisfied or when the user explicitly dismissed it. */}
        {isAdmin && (
          <AdminLaunchpad
            signals={setupSignals}
            translations={launchpadTranslations}
          />
        )}

        {/* Plan-state banner — SaaS only.
            stats.plan === 'trial' 在 on-prem 上理论上不可能出现（auth.ts
            createUser 已 gate on IS_SAAS），但加 CAN_BILLING 兜底，防止
            未来数据迁移意外引入 trial 状态时 UI 出现死链接。 */}
        {CLIENT_CAPABILITIES.billing &&
          stats.plan === 'trial' && stats.trialDaysLeft !== null && (
          <Alert variant="info">
            <AlertTitle>{t.trialActive}</AlertTitle>
            <AlertDescription>
              {t.trialDaysLeft}{' '}
              <Link
                href="/billing"
                className="font-medium text-primary underline-offset-2 hover:underline"
              >
                {t.upgradeNow}
              </Link>{' '}
              {t.toKeepProFeatures}
            </AlertDescription>
          </Alert>
        )}
        {stats.plan && stats.plan !== 'trial' && stats.plan !== 'free' && (
          <Alert variant="success" hideIcon>
            <Stack direction="row" gap={2} align="center">
              <CheckCircle2 className="size-5 text-success" aria-hidden />
              <span className="text-sm font-medium capitalize">{t.planActive}</span>
            </Stack>
          </Alert>
        )}

        {/* Stats grid */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label={t.stats.totalPolicies}
            value={stats.usage.policies || 0}
            limit={stats.usage.policiesLimit}
            limitTemplate={t.stats.limitTemplate}
          />
          <StatCard
            label={t.stats.executionsThisMonth}
            value={stats.usage.executions || 0}
            limit={stats.usage.executionsLimit}
            limitTemplate={t.stats.limitTemplate}
          />
          <StatCard
            label={t.stats.apiCalls}
            value={stats.usage.apiCalls || 0}
            limit={stats.features.apiAccess ? stats.usage.apiCallsLimit : undefined}
            limitTemplate={t.stats.limitTemplate}
            footer={
              !stats.features.apiAccess && CLIENT_CAPABILITIES.billing && (
                <Link href="/billing" className="text-xs text-primary hover:text-primary-hover">
                  {t.stats.upgradeForApi}
                </Link>
              )
            }
          />
          <StatCard
            label={t.stats.piiFieldsDetected}
            value={totalPiiFields}
            footer={
              totalPiiFields > 0 && (
                <p className="flex items-center gap-1 text-xs text-warning">
                  <AlertTriangle className="size-3.5" aria-hidden />
                  {t.stats.reviewRecommended}
                </p>
              )
            }
          />
        </div>

        {/* AHA-moment card — kept in its own slot (PM 02 NSM leading indicator) */}
        <AhaStatusCard locale={locale} />

        {/* AI + Policy API usage (PM v1.1) */}
        <div className="grid gap-4 md:grid-cols-2">
          <AiUsageCard locale={locale} />
          <ApiUsageCard locale={locale} />
        </div>

        {/* Quick actions */}
        <Stack gap={4}>
          <h2 className="font-display text-xl font-semibold tracking-tight text-fg">
            {t.quickActions.title}
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <QuickAction
              href="/policies/new"
              icon={Plus}
              tone="primary"
              title={t.quickActions.createPolicy}
              description={t.quickActions.createPolicyDesc}
            />
            <QuickAction
              href="/reports"
              icon={FileText}
              tone="success"
              title={t.quickActions.generateReport}
              description={t.quickActions.generateReportDesc}
            />
            <QuickAction
              href="/settings/api-keys"
              icon={KeyRound}
              tone="accent"
              title={t.quickActions.apiKeys}
              description={t.quickActions.apiKeysDesc}
            />
          </div>
        </Stack>

        {/* Recent policies list */}
        <Stack gap={4}>
          <Stack direction="row" justify="between" align="center">
            <h2 className="font-display text-xl font-semibold tracking-tight text-fg">
              {t.recentPolicies.title}
            </h2>
            <Link
              href="/policies"
              className="text-sm font-medium text-primary hover:text-primary-hover"
            >
              {t.recentPolicies.viewAll}
            </Link>
          </Stack>
          <Card>
            {policies.length === 0 ? (
              <EmptyPolicies
                noPolicies={t.recentPolicies.noPolicies}
                createFirst={t.recentPolicies.createFirst}
              />
            ) : (
              <ul className="divide-y divide-border">
                {policies.map((policy) => (
                  <PolicyRow
                    key={policy.id}
                    policy={policy}
                    noDescription={t.recentPolicies.noDescription}
                    runsTemplate={t.recentPolicies.runsTemplate}
                  />
                ))}
              </ul>
            )}
          </Card>
        </Stack>
      </Stack>
    </Container>
  );
}

/* ------------------------------------------------------------------ */
/* StatCard — value + optional progress bar + footer slot              */
/* ------------------------------------------------------------------ */

interface StatCardProps {
  label: string;
  value: number;
  limit?: number;
  limitTemplate?: string;
  footer?: React.ReactNode;
}

function StatCard({ label, value, limit, limitTemplate, footer }: StatCardProps) {
  const showBar = limit !== undefined && !isUnlimited(limit);
  const percent = showBar ? Math.min((value / Math.max(limit, 1)) * 100, 100) : 0;
  return (
    <Card>
      <CardBody className="pt-6">
        <Stack gap={2}>
          <p className="truncate text-sm font-medium text-fg-muted">{label}</p>
          <p className="font-display text-3xl font-semibold tracking-tight text-fg">
            {value.toLocaleString()}
          </p>
          {showBar && (
            <Stack gap={1}>
              <div className="h-2 w-full overflow-hidden rounded-full bg-bg-muted">
                <div
                  className="h-full bg-primary transition-all duration-medium ease-standard"
                  style={{ width: `${percent}%` }}
                />
              </div>
              {limitTemplate && (
                <p className="text-xs text-fg-subtle">
                  {formatTemplate(limitTemplate, { count: limit! })}
                </p>
              )}
            </Stack>
          )}
          {footer}
        </Stack>
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* QuickAction — icon tile + title + sub                               */
/* ------------------------------------------------------------------ */

type ActionTone = 'primary' | 'success' | 'accent' | 'warning' | 'danger' | 'neutral';

const ACTION_TONE_BG: Record<ActionTone, string> = {
  primary: 'bg-primary-subtle text-primary',
  success: 'bg-success-subtle text-success',
  accent:  'bg-accent-subtle text-accent',
  warning: 'bg-warning-subtle text-warning',
  danger:  'bg-danger-subtle text-danger',
  neutral: 'bg-bg-muted text-fg-muted',
};

interface QuickActionProps {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: ActionTone;
  title: string;
  description: string;
}

function QuickAction({ href, icon: Icon, tone, title, description }: QuickActionProps) {
  return (
    <Link
      href={href}
      className={cn(
        'flex items-center gap-4',
        'rounded-lg border border-border bg-bg p-4',
        'transition-all duration-fast ease-standard',
        'hover:border-border-strong hover:shadow-sm',
        'focus-visible:outline-none focus-visible:shadow-ring',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-md',
          ACTION_TONE_BG[tone],
        )}
      >
        <Icon className="size-5" />
      </span>
      <Stack gap={1}>
        <p className="text-sm font-medium text-fg">{title}</p>
        <p className="text-xs text-fg-muted">{description}</p>
      </Stack>
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/* Policy row                                                         */
/* ------------------------------------------------------------------ */

interface PolicyRowProps {
  policy: Policy;
  noDescription: string;
  runsTemplate: string;
}

function PolicyRow({ policy, noDescription, runsTemplate }: PolicyRowProps) {
  const runsText = formatTemplate(runsTemplate, { count: policy._count.executions });
  const piiCount = policy.piiFields?.length ?? 0;

  return (
    <li>
      <Link
        href={`/policies/${policy.id}`}
        className="block transition-colors duration-fast hover:bg-bg-subtle"
      >
        <div className="px-4 py-4 sm:px-6">
          <Stack gap={2}>
            <Stack direction="row" justify="between" align="center" gap={2}>
              <p className="truncate text-sm font-medium text-primary">{policy.name}</p>
              {piiCount > 0 && <Badge variant="warning">{piiCount} PII</Badge>}
            </Stack>
            <Stack direction="row" justify="between" align="center" gap={2}>
              <p className="truncate text-sm text-fg-muted">
                {policy.description || noDescription}
              </p>
              <p className="shrink-0 text-sm text-fg-subtle">{runsText}</p>
            </Stack>
          </Stack>
        </div>
      </Link>
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Empty state                                                        */
/* ------------------------------------------------------------------ */

function EmptyPolicies({ noPolicies, createFirst }: { noPolicies: string; createFirst: string }) {
  return (
    <div className="px-4 py-12 text-center">
      <Stack gap={3} align="center">
        <FileText className="size-10 text-fg-subtle" aria-hidden />
        <p className="text-fg-muted">{noPolicies}</p>
        <Link
          href="/policies/new"
          className="text-sm font-medium text-primary hover:text-primary-hover"
        >
          {createFirst}
        </Link>
      </Stack>
    </div>
  );
}
