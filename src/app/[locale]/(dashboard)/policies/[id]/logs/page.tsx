import { getSession } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { db, policies } from '@/lib/prisma';
import { eq, and, isNull } from 'drizzle-orm';
import { getTranslations } from 'next-intl/server';
import { queryExecutionLogs, getExecutionStats } from '@/lib/policy-execution-log';
import { LogsContent } from './logs-content';

async function getInitialLogsData(userId: string, policyId: string) {
  // 并行获取策略信息、日志和统计
  const [policy, logsResult, stats] = await Promise.all([
    db.query.policies.findFirst({
      where: and(
        eq(policies.id, policyId),
        eq(policies.userId, userId),
        isNull(policies.deletedAt)
      ),
      columns: {
        id: true,
        name: true,
      },
    }),
    queryExecutionLogs({
      userId,
      policyId,
      page: 1,
      pageSize: 20,
    }),
    getExecutionStats(userId, policyId, 30),
  ]);

  return { policy, logsResult, stats };
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

  if (!policy) {
    notFound();
  }

  // 序列化日志数据（Date -> string）
  const initialLogs = logsResult.items.map((item) => ({
    id: item.id,
    success: item.success,
    decision: item.decision,
    input: item.input,
    output: item.output,
    error: item.error,
    duration: item.durationMs,
    source: item.source,
    policyVersion: item.policyVersion,
    createdAt: item.createdAt.toISOString(),
    runnerParityStatus: item.runnerParityStatus,
  }));

  const initialStats = {
    totalExecutions: stats.totalExecutions,
    successCount: stats.successCount,
    failureCount: stats.failureCount,
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
      recentActivity: t('logs.recentActivity'),
      loadError: t('logs.loadError'),
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
