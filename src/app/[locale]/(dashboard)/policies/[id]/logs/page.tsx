import { getSession } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { executionExecutorScope, loadPolicyForAction } from '@/lib/policy-access';
import { getTranslations } from 'next-intl/server';
import { queryExecutionLogs, getExecutionStats } from '@/lib/policy-execution-log';
import { LogsContent } from './logs-content';
import { toClientLog } from './log-mapping';
import { localizedTitle } from '@/lib/page-metadata';

export const generateMetadata = localizedTitle('policies.logs', 'title');

async function getInitialLogsData(userId: string, policyId: string) {
  // 授权与日志 API 同一口径：团队策略任一当前成员可看，个人策略只认所有者（#669 #670）
  const access = await loadPolicyForAction(policyId, { userId }, 'view');
  if (!access.ok) return { policy: null, logsResult: null, stats: null };
  // 团队策略看全部成员的执行，个人策略只看所有者本人的执行（#673）
  const executorId = executionExecutorScope(access.policy);
  const [logsResult, stats] = await Promise.all([
    queryExecutionLogs({
      executorId,
      policyId,
      page: 1,
      pageSize: 20,
    }),
    getExecutionStats(executorId, policyId, 30),
  ]);

  return { policy: { id: access.policy.id, name: access.policy.name }, logsResult, stats };
}

export default async function PolicyLogsPage({
  params,
}: {
  params: Promise<{ id: string; locale: string }>;
}) {
  const { id, locale } = await params;
  const session = await getSession();
  if (!session?.user?.id) {
    redirect(`/${locale}/login`);
  }

  const { policy, logsResult, stats } = await getInitialLogsData(session.user.id, id);

  if (!policy || !logsResult || !stats) {
    notFound();
  }

  // 序列化日志数据（Date -> string）
  const initialLogs = logsResult.items.map((item) =>
    toClientLog({
      id: item.id,
      success: item.success,
      decision: item.decision,
      input: item.input,
      output: item.output,
      error: item.error,
      durationMs: item.durationMs,
      source: item.source,
      policyVersion: item.policyVersion,
      createdAt: item.createdAt.toISOString(),
      runnerParityStatus: item.runnerParityStatus,
      metadata: item.metadata,
    }),
  );

  const initialStats = {
    totalExecutions: stats.totalExecutions,
    successCount: stats.successCount,
    failureCount: stats.failureCount,
    errorCount: stats.errorCount,
    indeterminateCount: stats.indeterminateCount,
    pendingCount: stats.pendingCount,
    avgDurationMs: stats.avgDurationMs,
    successRate: stats.successRate,
    bySource: stats.bySource.map((s) => ({ source: s.source, count: s.count })),
    recentTrend: stats.recentTrend,
  };

  const t = await getTranslations('policies');

  const translations = {
    logs: {
      title: t('logs.title'),
      backToPolicy: t('logs.backToPolicy'),
      noLogs: t('logs.noLogs'),
      filter: t('logs.filter'),
      all: t('logs.all'),
      success: t('logs.success'),
      failed: t('logs.failed'),
      approved: t('logs.approved'),
      denied: t('logs.denied'),
      computed: t('logs.computed'),
      require_approval: t('logs.require_approval'),
      escalate: t('logs.escalate'),
      source: t('logs.source'),
      web: t('logs.web'),
      api: t('logs.api'),
      cli: t('logs.cli'),
      dateRange: t('logs.dateRange'),
      from: t('logs.from'),
      to: t('logs.to'),
      apply: t('logs.apply'),
      reset: t('logs.reset'),
      executedAt: t('logs.executedAt'),
      duration: t('logs.duration'),
      version: t('logs.version'),
      input: t('logs.input'),
      output: t('logs.output'),
      error: t('logs.error'),
      showMore: t('logs.showMore'),
      showLess: t('logs.showLess'),
      page: t('logs.page'),
      of: t('logs.of'),
      previous: t('logs.previous'),
      next: t('logs.next'),
      stats: t('logs.stats'),
      totalExecutions: t('logs.totalExecutions'),
      successRate: t('logs.successRate'),
      avgDuration: t('logs.avgDuration'),
      pendingLabel: t('logs.pendingLabel'),
      rateNote: t('logs.rateNote'),
      otherDecisionStates: t.raw('logs.otherDecisionStates' as never) as string,
      recentActivity: t('logs.recentActivity'),
      loadError: t('logs.loadError'),
      filtersTitle: t('logs.filtersTitle'),
      justNow: t('logs.justNow'),
      loadingLogs: t('logs.loadingLogs'),
      noLogsHint: t('logs.noLogsHint'),
      viewApproval: t('logs.viewApproval'),
      registerGuard: t('logs.registerGuard'),
      guardError: t('logs.guardError'),
      // ★parity 徽章文案：i18n 消息由外部 @aster-cloud/ui-messages 包发布（ADR 0018，cloud 不手维护
      //   messages/*）。为避免 t('logs.parity.*') 在包尚未发布该 key 时 throw missing-message，这里用
      //   t.has 探测——存在则本地化，否则留空由 LogsContent 的 `?? 默认英文` 兜底。ui-messages 发布该
      //   namespace 后此处自动本地化，无需改码。
      parity: t.has('logs.parity.match')
        ? {
            tooltip: t('logs.parity.tooltip'),
            match: t('logs.parity.match'),
            divergent: t('logs.parity.divergent'),
            unavailable: t('logs.parity.unavailable'),
            error: t('logs.parity.error'),
            indeterminate: t('logs.parity.indeterminate'),
          }
        : undefined,
    },
  };

  return (
    <LogsContent
      policyId={id}
      policyName={policy.name}
      translations={translations}
      locale={locale}
      initialLogs={initialLogs}
      initialStats={initialStats}
      initialTotalPages={logsResult.totalPages}
    />
  );
}
