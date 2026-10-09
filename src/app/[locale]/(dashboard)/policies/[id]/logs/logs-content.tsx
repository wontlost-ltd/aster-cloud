'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { formatDate } from '@/lib/format';
import { Link } from '@/i18n/navigation';
import { Breadcrumbs, Container, PageHeader } from '@/components/ui';

type ExecutionSource = 'WEB' | 'API' | 'CLI' | 'dashboard' | 'api' | 'playground';

interface ExecutionLog {
  id: string;
  success: boolean;
  /** 准入决策语义（approved/denied/indeterminate/error/require_approval/escalate）。历史行可能为 null。 */
  decision: 'approved' | 'denied' | 'indeterminate' | 'error' | 'require_approval' | 'escalate' | null;
  input: unknown;
  output: unknown;
  error: string | null;
  duration: number;
  source: ExecutionSource;
  policyVersion: number | null;
  createdAt: string;
  /** runner-parity 影子校验状态（null=未跑）。match|divergent|runner-unavailable|runner-error|authority-failure。 */
  runnerParityStatus: string | null;
  /** guard 登记结果（ADR 0042 §5.1）：成功带决策 id，失败带错误码；旧行/无需审批为 null。 */
  metadata?: { guardDecisionId?: string; guardApprovalId?: string; guardError?: string } | null;
}

interface Stats {
  totalExecutions: number;
  successCount: number;
  failureCount: number;
  /** 无决策（值/计算输出）执行数——不计入失败。可选（后端新增字段）。 */
  indeterminateCount?: number;
  /** 待人工处置（require_approval + escalate）执行数——不计入失败，也不参与通过率。 */
  pendingCount?: number;
  avgDurationMs: number;
  successRate: number;
  bySource: Array<{
    source: string;
    count: number;
  }>;
  recentTrend: Array<{
    date: string;
    successCount: number;
    failureCount: number;
  }>;
}

/**
 * 时长展示：API 字段名是 durationMs，历史行/异常数据可能缺失或非数字，
 * 此时显示「—」而非拼出 NaN。
 */
export function formatDuration(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** API 行（durationMs）→ 组件行（duration），与服务端 page.tsx 的序列化保持同一字段名。 */
function toClientLog(item: Omit<ExecutionLog, 'duration'> & { durationMs?: number; duration?: number }): ExecutionLog {
  return { ...item, duration: item.durationMs ?? item.duration ?? Number.NaN };
}

/** 日志行的展示分类：值输出 / 待人工处置（需批准、升级）/ 通过 / 失败。 */
type LogStatus = 'computed' | 'pending' | 'success' | 'failed';

/** 各展示分类的图标底色、徽章配色与图标路径。 */
const LOG_STATUS_STYLES: Record<LogStatus, { icon: string; badge: string; path: string }> = {
  computed: {
    icon: 'bg-blue-100 text-blue-600',
    badge: 'bg-blue-50 text-blue-700 ring-blue-600/20',
    path: 'M9 7h6m-6 4h6m-6 4h4M5 5a2 2 0 012-2h10a2 2 0 012 2v14l-4-2-3 2-3-2-3 2V5z',
  },
  pending: {
    icon: 'bg-amber-100 text-amber-600',
    badge: 'bg-amber-50 text-amber-700 ring-amber-600/20',
    path: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
  },
  success: {
    icon: 'bg-emerald-100 text-emerald-600',
    badge: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
    path: 'M5 13l4 4L19 7',
  },
  failed: {
    icon: 'bg-red-100 text-red-600',
    badge: 'bg-red-50 text-red-700 ring-red-600/20',
    path: 'M6 18L18 6M6 6l12 12',
  },
};

function logStatus(log: Pick<ExecutionLog, 'decision' | 'success'>): LogStatus {
  if (log.decision === 'indeterminate') return 'computed';
  if (log.decision === 'require_approval' || log.decision === 'escalate') return 'pending';
  return log.success ? 'success' : 'failed';
}

/**
 * 展开详情显示输出还是错误面板：按决策分类而非 success 判断。
 * require_approval/escalate 行 success=false（fail-closed），但不是失败，应展示输出而非错误面板。
 */
export function logDetailPanel(log: Pick<ExecutionLog, 'decision' | 'success'>): 'output' | 'error' {
  return logStatus(log) === 'failed' ? 'error' : 'output';
}

function logStatusLabel(log: ExecutionLog, t: Translations): string {
  if (log.decision === 'require_approval' || log.decision === 'escalate') return t.logs[log.decision];
  if (log.decision === 'indeterminate') return t.logs.computed;
  return log.success ? t.logs.success : t.logs.failed;
}

interface Translations {
  logs: {
    title: string;
    backToPolicy: string;
    noLogs: string;
    filter: string;
    all: string;
    success: string;
    failed: string;
    /** 值/计算输出（indeterminate）中性状态标签。 */
    computed: string;
    /** Verdict 需人工批准（require_approval）待处置标签。 */
    require_approval: string;
    /** Verdict 升级（escalate）待处置标签。 */
    escalate: string;
    source: string;
    web: string;
    api: string;
    cli: string;
    dateRange: string;
    from: string;
    to: string;
    apply: string;
    reset: string;
    executedAt: string;
    duration: string;
    version: string;
    input: string;
    output: string;
    error: string;
    showMore: string;
    showLess: string;
    page: string;
    of: string;
    previous: string;
    next: string;
    stats: string;
    totalExecutions: string;
    successRate: string;
    avgDuration: string;
    /** 待处置数量标签（统计卡）。 */
    pendingLabel: string;
    /** 通过率口径说明：仅统计已定论决策。 */
    rateNote: string;
    recentActivity: string;
    loadError: string;
    /** 待审批行「查看审批」链接文案。 */
    viewApproval: string;
    /** guard 登记失败行「重新登记」按钮文案。 */
    registerGuard: string;
    /** guard 登记失败提示（按钮 title）。 */
    guardError: string;
    /** runner-parity 影子校验徽章文案（可选——旧翻译包无此键时降级默认英文）。 */
    parity?: {
      tooltip: string;
      match: string;
      divergent: string;
      unavailable: string;
      error: string;
      indeterminate: string;
    };
  };
}

interface LogsContentProps {
  policyId: string;
  policyName: string;
  translations: Translations;
  locale: string;
  initialLogs: ExecutionLog[];
  initialStats: Stats;
  initialTotalPages: number;
}

// Source badge colors and icons
const sourceConfig: Record<ExecutionSource, { bg: string; text: string; ring: string; icon: React.ReactNode }> = {
  WEB: {
    bg: 'bg-blue-50',
    text: 'text-blue-700',
    ring: 'ring-blue-600/20',
    icon: (
      <svg className="h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
      </svg>
    ),
  },
  API: {
    bg: 'bg-accent-subtle',
    text: 'text-accent-hover',
    ring: 'ring-accent/20',
    icon: (
      <svg className="h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    ),
  },
  CLI: {
    bg: 'bg-bg-muted',
    text: 'text-fg',
    ring: 'ring-gray-600/20',
    icon: (
      <svg className="h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    ),
  },
  // Prisma enum values (lowercase)
  dashboard: {
    bg: 'bg-blue-50',
    text: 'text-blue-700',
    ring: 'ring-blue-600/20',
    icon: (
      <svg className="h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
      </svg>
    ),
  },
  api: {
    bg: 'bg-accent-subtle',
    text: 'text-accent-hover',
    ring: 'ring-accent/20',
    icon: (
      <svg className="h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    ),
  },
  playground: {
    bg: 'bg-green-50',
    text: 'text-green-700',
    ring: 'ring-green-600/20',
    icon: (
      <svg className="h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
};

/** runner-parity 徽章配色（match=绿 / divergent=红 / 其余=灰）。 */
function parityBadge(status: string): string {
  switch (status) {
    case 'match':
      return 'bg-green-50 text-green-700 ring-green-600/20';
    case 'divergent':
      return 'bg-red-50 text-red-700 ring-red-600/20';
    default: // runner-unavailable | runner-error | authority-failure
      return 'bg-bg-muted text-fg-muted ring-gray-600/20';
  }
}

/** runner-parity 徽章文案（i18n，缺翻译降级默认英文）。 */
function parityLabel(status: string, t: Translations): string {
  const p = t.logs.parity;
  switch (status) {
    case 'match':
      return p?.match ?? 'parity ✓';
    case 'divergent':
      return p?.divergent ?? 'parity ✗';
    case 'runner-unavailable':
      return p?.unavailable ?? 'parity —';
    case 'runner-error':
      return p?.error ?? 'parity err';
    default: // authority-failure
      return p?.indeterminate ?? 'parity ?';
  }
}

const GUARD_PILL = 'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset';

/** 重试永远不会成功的登记错误：无证据锚（no_evidence）的行不给重新登记按钮。 */
const NON_RETRYABLE_GUARD_ERRORS = new Set(['no_evidence']);

/** 状态徽章旁的 guard 入口：有决策 id → 收件箱链接；有可重试的 guardError → 重新登记按钮；其余不渲染。 */
function GuardAction({
  log,
  policyId,
  t,
  onUpdated,
}: {
  log: ExecutionLog;
  policyId: string;
  t: Translations;
  onUpdated: (logId: string, metadata: ExecutionLog['metadata']) => void;
}) {
  const [busy, setBusy] = useState(false);
  const meta = log.metadata;

  const register = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/policies/${policyId}/executions/${log.id}/guard-register`, { method: 'POST' });
      const body = (await res.json().catch(() => null)) as { metadata?: ExecutionLog['metadata'] } | null;
      if (body?.metadata) onUpdated(log.id, body.metadata);
    } finally {
      setBusy(false);
    }
  };

  if (meta?.guardDecisionId) {
    return (
      <Link
        href={`/approvals?decisionId=${encodeURIComponent(meta.guardDecisionId)}`}
        className={`${GUARD_PILL} bg-amber-50 text-amber-700 ring-amber-600/20 hover:bg-amber-100`}
      >
        {t.logs.viewApproval}
      </Link>
    );
  }
  if (!meta?.guardError || NON_RETRYABLE_GUARD_ERRORS.has(meta.guardError)) return null;
  return (
    <button
      type="button"
      onClick={register}
      disabled={busy}
      title={`${t.logs.guardError}: ${meta.guardError}`}
      className={`${GUARD_PILL} bg-red-50 text-red-700 ring-red-600/20 hover:bg-red-100 disabled:opacity-50`}
    >
      {t.logs.registerGuard}
    </button>
  );
}

export function LogsContent({
  policyId,
  policyName,
  translations: t,
  locale,
  initialLogs,
  initialStats,
  initialTotalPages,
}: LogsContentProps) {
  // 面包屑根级 "Policies" 标签复用 policies 命名空间（与 versions 页一致）
  const tPolicies = useTranslations('policies');

  // 使用服务端提供的初始数据，避免客户端首次加载时的空白
  const [logs, setLogs] = useState<ExecutionLog[]>(initialLogs);
  const [stats, setStats] = useState<Stats | null>(initialStats);
  const [loading, setLoading] = useState(false); // 初始数据已有，无需加载状态
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(initialTotalPages);
  const [expandedLog, setExpandedLog] = useState<string | null>(null);

  // 重新登记后只就地更新该行 metadata，不整页重拉
  const updateLogMetadata = useCallback((logId: string, metadata: ExecutionLog['metadata']) => {
    setLogs((prev) => prev.map((l) => (l.id === logId ? { ...l, metadata } : l)));
  }, []);

  // Filters
  const [successFilter, setSuccessFilter] = useState<string>('');
  const [sourceFilter, setSourceFilter] = useState<string>('');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');

  // 跟踪是否为首次挂载，避免重复获取服务端已提供的数据
  const isInitialMount = useRef(true);

  // signal 由调用方的 useEffect 提供：切换筛选条件会连发多个请求，
  // 没有取消机制时**先发后到**的旧响应会覆盖新结果——表格显示的数据与
  // 下拉框显示的筛选条件不一致，且没有任何错误提示。审计发现（2026-07-29）。
  const fetchLogs = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');

    try {
      const params = new URLSearchParams({
        page: page.toString(),
        pageSize: '20',
      });

      if (successFilter) params.append('success', successFilter);
      if (sourceFilter) params.append('source', sourceFilter);
      if (startDate) params.append('startDate', startDate);
      if (endDate) params.append('endDate', endDate);

      const res = await fetch(`/api/policies/${policyId}/logs?${params}`, { signal });
      if (!res.ok) throw new Error('Failed to fetch logs');

      const data = await res.json();
      setLogs((data.items || []).map(toClientLog));
      setTotalPages(data.pagination?.totalPages || 1);
    } catch (err) {
      // 被取消不是错误：这是更新的请求接手了，静默返回并把 loading
      // 留给那个请求收尾，避免闪一下错误态。
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(t.logs.loadError);
      console.error(err);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [policyId, page, successFilter, sourceFilter, startDate, endDate, t.logs.loadError]);

  // fetchStats 保留供手动刷新使用，添加下划线前缀避免 lint 报错
  const _fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`/api/policies/${policyId}/logs?mode=stats&days=30`);
      if (!res.ok) return;

      const data = await res.json();
      setStats(data.stats);
    } catch (err) {
      console.error('Failed to fetch stats:', err);
    }
  }, [policyId]);

  // 仅在筛选条件或分页变化时获取数据，首次挂载使用服务端数据
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    const controller = new AbortController();
    fetchLogs(controller.signal);
    return () => controller.abort();
  }, [fetchLogs]);

  // Stats 已在服务端获取，无需客户端重新获取
  // 如果需要刷新 stats，可以在特定操作后手动调用 fetchStats

  const resetFilters = () => {
    setSuccessFilter('');
    setSourceFilter('');
    setStartDate('');
    setEndDate('');
    setPage(1);
  };

  const hasActiveFilters = successFilter || sourceFilter || startDate || endDate;

  const getSourceLabel = (source: string) => {
    switch (source) {
      case 'WEB':
        return t.logs.web;
      case 'API':
        return t.logs.api;
      case 'CLI':
        return t.logs.cli;
      default:
        return source;
    }
  };

  const formatRelativeTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return formatDate(dateStr, locale);
  };

  return (
    <Container size="xl" className="py-6 sm:py-10">
      {/* deep 页：保留面包屑（Policies > 策略名 > Logs），原返回箭头由面包屑导航取代。 */}
      <PageHeader
        title={t.logs.title}
        breadcrumbs={
          <Breadcrumbs
            items={[
              { label: tPolicies('title'), href: '/policies' },
              { label: policyName, href: `/policies/${policyId}` },
              { label: t.logs.title },
            ]}
          />
        }
        className="mb-6"
      />

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-8">
          {/* Total Executions */}
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-primary to-primary p-6 shadow-lg">
            <div className="absolute top-0 right-0 -mt-4 -mr-4 h-24 w-24 rounded-full bg-bg/10" />
            <div className="relative">
              <div className="flex items-center">
                <div className="flex-shrink-0 rounded-lg bg-bg/20 p-3">
                  <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
              </div>
              <p className="mt-4 text-sm font-medium text-primary-fg">{t.logs.totalExecutions}</p>
              <p className="mt-1 text-3xl font-bold text-white">{stats.totalExecutions.toLocaleString()}</p>
            </div>
          </div>

          {/* Success Rate */}
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-600 p-6 shadow-lg">
            <div className="absolute top-0 right-0 -mt-4 -mr-4 h-24 w-24 rounded-full bg-bg/10" />
            <div className="relative">
              <div className="flex items-center">
                <div className="flex-shrink-0 rounded-lg bg-bg/20 p-3">
                  <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
              </div>
              <p className="mt-4 text-sm font-medium text-emerald-100">{t.logs.successRate}</p>
              <p className="mt-1 text-3xl font-bold text-white">
                {Math.round(stats.successRate)}%
              </p>
              <p className="mt-1 text-xs text-emerald-200">
                {stats.successCount} / {stats.successCount + stats.failureCount}
              </p>
              <p className="mt-1 text-xs text-emerald-200" data-testid="logs-rate-note">
                {t.logs.pendingLabel}: {(stats.pendingCount ?? 0).toLocaleString()} · {t.logs.rateNote}
              </p>
            </div>
          </div>

          {/* Failed */}
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-rose-500 to-rose-600 p-6 shadow-lg">
            <div className="absolute top-0 right-0 -mt-4 -mr-4 h-24 w-24 rounded-full bg-bg/10" />
            <div className="relative">
              <div className="flex items-center">
                <div className="flex-shrink-0 rounded-lg bg-bg/20 p-3">
                  <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                </div>
              </div>
              <p className="mt-4 text-sm font-medium text-rose-100">{t.logs.failed}</p>
              <p className="mt-1 text-3xl font-bold text-white">{stats.failureCount.toLocaleString()}</p>
            </div>
          </div>

          {/* Avg Duration */}
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-amber-500 to-amber-600 p-6 shadow-lg">
            <div className="absolute top-0 right-0 -mt-4 -mr-4 h-24 w-24 rounded-full bg-bg/10" />
            <div className="relative">
              <div className="flex items-center">
                <div className="flex-shrink-0 rounded-lg bg-bg/20 p-3">
                  <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
              </div>
              <p className="mt-4 text-sm font-medium text-amber-100">{t.logs.avgDuration}</p>
              <p className="mt-1 text-3xl font-bold text-white">{formatDuration(stats.avgDurationMs)}</p>
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="bg-bg shadow-sm rounded-xl border border-border p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center">
            <svg className="h-5 w-5 text-fg-subtle mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
            </svg>
            <h3 className="text-sm font-semibold text-fg">{t.logs.filter}</h3>
          </div>
          {hasActiveFilters && (
            <button
              onClick={resetFilters}
              className="inline-flex items-center text-sm text-fg-muted hover:text-fg"
            >
              <svg className="h-4 w-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
              {t.logs.reset}
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
          <div>
            <label className="block text-xs font-semibold text-fg-muted uppercase tracking-wide mb-2">
              Status
            </label>
            <select
              value={successFilter}
              onChange={(e) => {
                setSuccessFilter(e.target.value);
                setPage(1);
              }}
              className="block w-full rounded-lg border border-border-strong bg-bg px-4 py-2.5 text-fg shadow-sm transition-all duration-200 focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none hover:border-gray-400 sm:text-sm cursor-pointer"
            >
              <option value="">{t.logs.all}</option>
              <option value="true">{t.logs.success}</option>
              <option value="false">{t.logs.failed}</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-fg-muted uppercase tracking-wide mb-2">
              {t.logs.source}
            </label>
            <select
              value={sourceFilter}
              onChange={(e) => {
                setSourceFilter(e.target.value);
                setPage(1);
              }}
              className="block w-full rounded-lg border border-border-strong bg-bg px-4 py-2.5 text-fg shadow-sm transition-all duration-200 focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none hover:border-gray-400 sm:text-sm cursor-pointer"
            >
              <option value="">{t.logs.all}</option>
              <option value="WEB">{t.logs.web}</option>
              <option value="API">{t.logs.api}</option>
              <option value="CLI">{t.logs.cli}</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-fg-muted uppercase tracking-wide mb-2">
              {t.logs.from}
            </label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="block w-full rounded-lg border border-border-strong bg-bg px-4 py-2.5 text-fg shadow-sm transition-all duration-200 focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none hover:border-gray-400 sm:text-sm cursor-pointer"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-fg-muted uppercase tracking-wide mb-2">
              {t.logs.to}
            </label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="block w-full rounded-lg border border-border-strong bg-bg px-4 py-2.5 text-fg shadow-sm transition-all duration-200 focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none hover:border-gray-400 sm:text-sm cursor-pointer"
            />
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-6 rounded-xl bg-red-50 border border-red-200 p-4">
          <div className="flex">
            <svg className="h-5 w-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="ml-3 text-sm text-red-700">{error}</p>
          </div>
        </div>
      )}

      {/* Logs List */}
      <div className="bg-bg shadow-sm rounded-xl border border-border overflow-hidden">
        {loading ? (
          <div className="p-12 text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-primary-subtle mb-4">
              <svg className="animate-spin h-6 w-6 text-primary" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            </div>
            <p className="text-sm text-fg-muted">Loading execution logs...</p>
          </div>
        ) : logs.length === 0 ? (
          <div className="p-12 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-bg-muted mb-4">
              <svg className="h-8 w-8 text-fg-subtle" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
            </div>
            <h3 className="text-sm font-medium text-fg mb-1">{t.logs.noLogs}</h3>
            <p className="text-sm text-fg-muted">Execute the policy to see logs here</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {logs.map((log) => (
              <div
                key={log.id}
                className={`transition-colors ${expandedLog === log.id ? 'bg-bg-subtle' : 'hover:bg-bg-subtle/50'}`}
              >
                {/* Log Header */}
                <div className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {/* Status Icon + Badge —— 由 logStatus 统一分类：indeterminate 中性蓝「已计算」、
                          require_approval/escalate 琥珀色待处置、success(=allowed) 绿、真实拒绝/错误红。 */}
                      <div
                        className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${LOG_STATUS_STYLES[logStatus(log)].icon}`}
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={LOG_STATUS_STYLES[logStatus(log)].path} />
                        </svg>
                      </div>

                      {/* Status Badge */}
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${LOG_STATUS_STYLES[logStatus(log)].badge}`}
                      >
                        {logStatusLabel(log, t)}
                      </span>

                      {/* guard 审批入口（ADR 0042 §5.4）：已登记链到收件箱定位，登记失败可重新登记 */}
                      <GuardAction log={log} policyId={policyId} t={t} onUpdated={updateLogMetadata} />

                      {/* Source Badge */}
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${
                          sourceConfig[log.source]?.bg || 'bg-bg-muted'
                        } ${sourceConfig[log.source]?.text || 'text-fg'} ${
                          sourceConfig[log.source]?.ring || 'ring-gray-600/20'
                        }`}
                      >
                        {sourceConfig[log.source]?.icon}
                        {getSourceLabel(log.source)}
                      </span>

                      {/* runner-parity 影子校验徽章（仅已跑的行显示；null=未跑不渲染） */}
                      {log.runnerParityStatus && (
                        <span
                          className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${parityBadge(log.runnerParityStatus)}`}
                          title={t.logs.parity?.tooltip ?? 'runner replay parity'}
                        >
                          {parityLabel(log.runnerParityStatus, t)}
                        </span>
                      )}

                      {/* Version */}
                      {log.policyVersion && (
                        <span className="inline-flex items-center rounded-md bg-bg-muted px-2 py-1 text-xs font-medium text-fg-muted">
                          v{log.policyVersion}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-4">
                      {/* Duration */}
                      <div className="flex items-center text-sm text-fg-muted">
                        <svg className="h-4 w-4 mr-1 text-fg-subtle" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <span className="font-medium">{formatDuration(log.duration)}</span>
                      </div>

                      {/* Timestamp */}
                      <div className="text-sm text-fg-subtle" title={new Date(log.createdAt).toLocaleString()}>
                        {formatRelativeTime(log.createdAt)}
                      </div>

                      {/* Expand/Collapse Button */}
                      <button
                        onClick={() => setExpandedLog(expandedLog === log.id ? null : log.id)}
                        className={`inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                          expandedLog === log.id
                            ? 'bg-primary-subtle text-primary-hover'
                            : 'text-fg-muted hover:bg-bg-muted'
                        }`}
                      >
                        {expandedLog === log.id ? (
                          <>
                            <svg className="h-4 w-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                            </svg>
                            {t.logs.showLess}
                          </>
                        ) : (
                          <>
                            <svg className="h-4 w-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                            </svg>
                            {t.logs.showMore}
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Expanded Content */}
                {expandedLog === log.id && (
                  <div className="px-4 pb-4">
                    <div className="ml-11 space-y-4">
                      {/* Input */}
                      <div className="rounded-lg border border-border overflow-hidden">
                        <div className="bg-bg-subtle px-4 py-2 border-b border-border">
                          <h4 className="text-xs font-semibold text-fg-muted uppercase tracking-wide flex items-center">
                            <svg className="h-4 w-4 mr-1.5 text-fg-subtle" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
                            </svg>
                            {t.logs.input}
                          </h4>
                        </div>
                        <pre className="bg-bg p-4 text-xs overflow-x-auto font-mono text-fg max-h-48">
                          {JSON.stringify(log.input, null, 2)}
                        </pre>
                      </div>

                      {/* Output or Error：由 logDetailPanel 按决策分类，待处置行展示输出 */}
                      {logDetailPanel(log) === 'output' ? (
                        <div className="rounded-lg border border-emerald-200 overflow-hidden">
                          <div className="bg-emerald-50 px-4 py-2 border-b border-emerald-200">
                            <h4 className="text-xs font-semibold text-emerald-700 uppercase tracking-wide flex items-center">
                              <svg className="h-4 w-4 mr-1.5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                              </svg>
                              {t.logs.output}
                            </h4>
                          </div>
                          <pre className="bg-bg p-4 text-xs overflow-x-auto font-mono text-fg max-h-48">
                            {JSON.stringify(log.output, null, 2)}
                          </pre>
                        </div>
                      ) : (
                        <div className="rounded-lg border border-red-200 overflow-hidden">
                          <div className="bg-red-50 px-4 py-2 border-b border-red-200">
                            <h4 className="text-xs font-semibold text-red-700 uppercase tracking-wide flex items-center">
                              <svg className="h-4 w-4 mr-1.5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                              {t.logs.error}
                            </h4>
                          </div>
                          <pre className="bg-bg p-4 text-xs overflow-x-auto font-mono text-red-600 max-h-48">
                            {log.error}
                          </pre>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="bg-bg-subtle px-4 py-4 flex items-center justify-between border-t border-border">
            <div className="flex items-center text-sm text-fg-muted">
              <span className="font-medium text-fg">{t.logs.page} {page}</span>
              <span className="mx-1">{t.logs.of}</span>
              <span className="font-medium text-fg">{totalPages}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="inline-flex items-center rounded-lg bg-bg px-3 py-2 text-sm font-medium text-fg shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-bg-subtle disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <svg className="h-4 w-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                {t.logs.previous}
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="inline-flex items-center rounded-lg bg-bg px-3 py-2 text-sm font-medium text-fg shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-bg-subtle disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {t.logs.next}
                <svg className="h-4 w-4 ml-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        )}
      </div>
    </Container>
  );
}
