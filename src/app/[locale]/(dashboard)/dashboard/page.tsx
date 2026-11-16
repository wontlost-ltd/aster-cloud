import { getSession } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { isAdminFromSession } from '@/lib/admin-auth';
import { DashboardContent } from './dashboard-content';
import { localizedTitle } from '@/lib/page-metadata';
import { getDashboardData } from './dashboard-data';
import { listPendingVersionApprovals } from '@/lib/version-approvals-inbox';
import { buildGettingStartedItems } from '@/lib/onboarding/getting-started';
import { CAN_BILLING } from '@/lib/deployment-mode';
import { loadGettingStartedSignals } from '@/lib/onboarding/getting-started-signals';

export const generateMetadata = localizedTitle('dashboardNav', 'dashboard');

export default async function DashboardPage() {
  const session = await getSession();
  if (!session?.user?.id) {
    redirect('/login');
  }

  const [{ stats, policies }, versionApprovals] = await Promise.all([
    getDashboardData(session.user.id),
    listPendingVersionApprovals(session.user.id),
  ]);
  const t = await getTranslations('dashboard');
  // 仪表盘只放「轮到我审批」的版本；作者本人的提交（canAct=false）留在 /approvals 只读展示，四眼规则不变
  const pendingApprovals = versionApprovals
    .filter((v) => v.canAct)
    .map(({ versionId, policyId, policyName, version, submittedBy }) => ({ versionId, policyId, policyName, version, submittedBy }));
  const locale = await getLocale();

  /*
   * 上手清单（#796）：每个用户都有，条目按是否平台管理员区分。完成信号按当前用户从真实数据派生，
   * 一条查询算完（见 getting-started-signals.ts）；服务端算好条目，首屏一次渲染、无客户端请求。
   */
  const adminContext = await isAdminFromSession();
  const isAdmin = adminContext !== null;
  const gettingStartedSignals = await loadGettingStartedSignals({
    userId: session.user.id,
    hasPolicy: (stats.usage.policies ?? 0) > 0,
    plan: stats.plan,
  });
  const gettingStartedItems = buildGettingStartedItems({
    signals: gettingStartedSignals,
    isAdmin,
    billing: CAN_BILLING,
    firstPolicyId: policies[0]?.id ?? null,
  });

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

  return (
    <DashboardContent
      stats={stats}
      policies={policies}
      userId={session.user.id}
      isAdmin={isAdmin}
      gettingStartedItems={gettingStartedItems}
      totalPiiFields={totalPiiFields}
      translations={translations}
      locale={locale}
      pendingApprovals={pendingApprovals}
      pendingApprovalsLabels={{
        title: t('pendingApprovals.title'),
        subtitle: t('pendingApprovals.subtitle'),
        review: t('pendingApprovals.review'),
        submittedBy: t.raw('pendingApprovals.submittedBy') as string,
        unknownUser: t('pendingApprovals.unknownUser'),
        viewAll: t('pendingApprovals.viewAll'),
      }}
    />
  );
}
