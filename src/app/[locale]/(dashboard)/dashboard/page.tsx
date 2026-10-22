import { getSession } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { db, apiKeys, aiKeyBindings, teamMembers } from '@/lib/prisma';
import { eq, sql, and } from 'drizzle-orm';
import { getLocale, getTranslations } from 'next-intl/server';
import { isAdminFromSession } from '@/lib/admin-auth';
import { DashboardContent } from './dashboard-content';
import { localizedTitle } from '@/lib/page-metadata';
import { getDashboardData } from './dashboard-data';

export const generateMetadata = localizedTitle('dashboardNav', 'dashboard');

export default async function DashboardPage() {
  const session = await getSession();
  if (!session?.user?.id) {
    redirect('/login');
  }

  const { stats, policies } = await getDashboardData(session.user.id);
  const t = await getTranslations('dashboard');
  const locale = await getLocale();

  /*
   * Admin launchpad signals — five booleans that drive the first-run
   * checklist component. We resolve them in parallel; each query is a
   * primary-key / user-id-scoped lookup, so the round trip is cheap.
   * The launchpad component itself decides whether to render based on
   * `isAdmin && setupSignals.outstanding > 0`.
   *
   * Why server-side: NextAuth's JWT exposes `isAdmin`, but the other
   * four flags need DB lookups anyway, so co-locating them keeps the
   * first-paint a single render with no client fetch.
   */
  const adminContext = await isAdminFromSession();
  const isAdmin = adminContext !== null;
  const [aiKeyCount, apiKeyCount, teamMemberCount] = await Promise.all([
    db
      .select({ c: sql<number>`count(*)::int` })
      .from(aiKeyBindings)
      .where(
        and(
          eq(aiKeyBindings.userId, session.user.id),
          eq(aiKeyBindings.active, true),
        ),
      )
      .then((r) => r[0]?.c ?? 0),
    db
      .select({ c: sql<number>`count(*)::int` })
      .from(apiKeys)
      .where(eq(apiKeys.userId, session.user.id))
      .then((r) => r[0]?.c ?? 0),
    db
      .select({ c: sql<number>`count(*)::int` })
      .from(teamMembers)
      .where(eq(teamMembers.userId, session.user.id))
      .then((r) => r[0]?.c ?? 0),
  ]);

  const setupSignals = {
    hasPolicy: (stats.usage.policies ?? 0) > 0,
    hasApiKey: apiKeyCount > 0,
    hasAiKey: aiKeyCount > 0,
    hasTeammate: teamMemberCount > 1, // 1 = solo (just the admin themselves)
    hasReviewedBilling: stats.plan !== 'trial' && stats.plan !== 'free',
  };

  // 预计算 PII 总数
  const totalPiiFields = policies.reduce(
    (sum, p) => sum + (p.piiFields?.length || 0),
    0
  );

  // 预渲染翻译字符串（避免客户端加载）
  const translations = {
    welcomeBack: t('welcomeBack', { name: session.user.name?.split(' ')[0] || 'there' }),
    newPolicy: t('newPolicy'),
    trialActive: t('trialActive'),
    trialDaysLeft: stats.trialDaysLeft === 1
      ? t('trialDaysLeft', { count: stats.trialDaysLeft })
      : t('trialDaysLeftPlural', { count: stats.trialDaysLeft ?? 0 }),
    upgradeNow: t('upgradeNow'),
    toKeepProFeatures: t('toKeepProFeatures'),
    planActive: t('planActive', { plan: stats.plan }),
    stats: {
      totalPolicies: t('stats.totalPolicies'),
      executionsThisMonth: t('stats.executionsThisMonth'),
      // 该卡片计的是 cloud 自身 /api/v1 REST 调用；Policy 执行 API 另有用量卡片，二者是独立计量
      apiCalls: t('stats.restApiCalls'),
      piiFieldsDetected: t('stats.piiFieldsDetected'),
      limitTemplate: t.raw('stats.limit'),
      upgradeForApi: t('stats.upgradeForApi'),
      reviewRecommended: t('stats.reviewRecommended'),
    },
    quickActions: {
      title: t('quickActions.title'),
      createPolicy: t('quickActions.createPolicy'),
      createPolicyDesc: t('quickActions.createPolicyDesc'),
      generateReport: t('quickActions.generateReport'),
      generateReportDesc: t('quickActions.generateReportDesc'),
      apiKeys: t('quickActions.apiKeys'),
      apiKeysDesc: t('quickActions.apiKeysDesc'),
    },
    recentPolicies: {
      title: t('recentPolicies.title'),
      viewAll: t('recentPolicies.viewAll'),
      noPolicies: t('recentPolicies.noPolicies'),
      createFirst: t('recentPolicies.createFirst'),
      noDescription: t('recentPolicies.noDescription'),
      runsTemplate: t.raw('recentPolicies.runs'),
    },
  };

  // adminLaunchpad lives in its own root namespace so it can be shared
  // by other admin surfaces later without a dashboard.* prefix.
  const tLaunch = await getTranslations('adminLaunchpad');
  const launchpadTranslations = {
    title: tLaunch('title'),
    body: tLaunch('body'),
    progressTemplate: tLaunch.raw('progress'),
    dismiss: tLaunch('dismiss'),
    steps: {
      createPolicy: {
        label: tLaunch('steps.createPolicy.label'),
        desc: tLaunch('steps.createPolicy.desc'),
        cta: tLaunch('steps.createPolicy.cta'),
      },
      addApiKey: {
        label: tLaunch('steps.addApiKey.label'),
        desc: tLaunch('steps.addApiKey.desc'),
        cta: tLaunch('steps.addApiKey.cta'),
      },
      addAiKey: {
        label: tLaunch('steps.addAiKey.label'),
        desc: tLaunch('steps.addAiKey.desc'),
        cta: tLaunch('steps.addAiKey.cta'),
      },
      inviteTeam: {
        label: tLaunch('steps.inviteTeam.label'),
        desc: tLaunch('steps.inviteTeam.desc'),
        cta: tLaunch('steps.inviteTeam.cta'),
      },
      reviewBilling: {
        label: tLaunch('steps.reviewBilling.label'),
        desc: tLaunch('steps.reviewBilling.desc'),
        cta: tLaunch('steps.reviewBilling.cta'),
      },
    },
  };

  return (
    <DashboardContent
      stats={stats}
      policies={policies}
      isAdmin={isAdmin}
      setupSignals={setupSignals}
      launchpadTranslations={launchpadTranslations}
      totalPiiFields={totalPiiFields}
      translations={translations}
      locale={locale}
    />
  );
}
