'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { SecurityEventType, EventSeverity } from '@/lib/prisma';
import { securityEventDisplayType } from '@/lib/security-event-display';
import { formatSecurityCount, formatSecurityPercentage } from '@/lib/security-number-format';

interface SecurityStats {
  total: number;
  bySeverity: Record<EventSeverity, number>;
  byType: Record<string, number>;
  errorRate: number;
  period: {
    startDate: string;
    endDate: string;
  };
}

interface SecurityEvent {
  id: string;
  eventType: SecurityEventType;
  severity: EventSeverity;
  policyId: string | null;
  userId: string | null;
  ipAddress: string | null;
  requestId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

interface SecurityDashboardProps {
  policyId?: string;
}

// R32 P0 fix：每个 severity 都补 dark: variant。原本只有 light-mode 配色，
// dark mode 下 yellow-700 on zinc-950 ≈ 2.5:1，WCAG fail；类似 blue/red 都不达标。
// dark token 用 *-300 → *-400 范围保证 ≥ 4.5:1 contrast。
const SEVERITY_CONFIG: Record<EventSeverity, { color: string; bgColor: string }> = {
  INFO:     { color: 'text-blue-700   dark:text-blue-300',   bgColor: 'bg-blue-100   dark:bg-blue-950/40' },
  WARNING:  { color: 'text-yellow-800 dark:text-yellow-300', bgColor: 'bg-yellow-100 dark:bg-yellow-950/40' },
  ERROR:    { color: 'text-red-700    dark:text-red-300',    bgColor: 'bg-red-100    dark:bg-red-950/40' },
  CRITICAL: { color: 'text-red-900    dark:text-red-200',    bgColor: 'bg-red-200    dark:bg-red-900/40' },
};

type TimeRange = '1h' | '24h' | '7d' | '30d';

export function SecurityDashboard({ policyId }: SecurityDashboardProps) {
  // 事件时间按当前 locale 格式化（原硬编码 'zh-CN'，德语/印地语用户看到中文格式）。
  const locale = useLocale();
  const tType = useTranslations('security.eventTypes');
  const t = useTranslations('security.dashboard');
  const tNewEventType = (key: string) => tType(key as never) as string;
  // 事件类型 → 本地化标签。键写成字面量，便于 check:message-keys 静态核对；
  // 未知类型（新枚举值尚未补文案）回落显示原始 id。
  const eventTypeLabels: Record<string, string> = {
    SIGNATURE_INVALID: tType('SIGNATURE_INVALID'),
    NONCE_REUSED: tType('NONCE_REUSED'),
    TIMESTAMP_EXPIRED: tType('TIMESTAMP_EXPIRED'),
    HASH_MISMATCH: tType('HASH_MISMATCH'),
    UNAUTHORIZED_APPROVAL: tType('UNAUTHORIZED_APPROVAL'),
    SELF_APPROVAL_ATTEMPT: tType('SELF_APPROVAL_ATTEMPT'),
    POLICY_EXECUTED: tType('POLICY_EXECUTED'),
    POLICY_EXECUTION_FAILED: tType('POLICY_EXECUTION_FAILED'),
    APPROVAL_SUBMITTED: tType('APPROVAL_SUBMITTED'),
    APPROVAL_DECISION: tType('APPROVAL_DECISION'),
    VERSION_CREATED: tType('VERSION_CREATED'),
    VERSION_NOT_FOUND: tType('VERSION_NOT_FOUND'),
    DEPRECATED_VERSION_EXECUTED: tType('DEPRECATED_VERSION_EXECUTED'),
    VERSION_SET_DEFAULT: tType('VERSION_SET_DEFAULT'),
    VERSION_DEPRECATED: tType('VERSION_DEPRECATED'),
    VERSION_ARCHIVED: tType('VERSION_ARCHIVED'),
    API_KEY_CREATED: tNewEventType('API_KEY_CREATED'),
    API_KEY_REVOKED: tNewEventType('API_KEY_REVOKED'),
    TEAM_CREATED: tNewEventType('TEAM_CREATED'),
    TEAM_DELETED: tNewEventType('TEAM_DELETED'),
    TEAM_OWNERSHIP_TRANSFERRED: tNewEventType('TEAM_OWNERSHIP_TRANSFERRED'),
    TEAM_MEMBER_REMOVED: tNewEventType('TEAM_MEMBER_REMOVED'),
    POLICY_TRASHED: tNewEventType('POLICY_TRASHED'),
    POLICY_RESTORED: tNewEventType('POLICY_RESTORED'),
    POLICY_PERMANENTLY_DELETED: tNewEventType('POLICY_PERMANENTLY_DELETED'),
  };
  const eventTypeLabel = (type: string) => eventTypeLabels[type] ?? type;
  const [stats, setStats] = useState<SecurityStats | null>(null);
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>('24h');
  const [selectedSeverity, setSelectedSeverity] = useState<EventSeverity | 'ALL'>('ALL');

  const getTimeRangeParams = useCallback((range: TimeRange) => {
    const end = new Date();
    let start: Date;

    switch (range) {
      case '1h':
        start = new Date(end.getTime() - 60 * 60 * 1000);
        break;
      case '24h':
        start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
        break;
      case '7d':
        start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
    }

    return {
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    };
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const { startDate, endDate } = getTimeRangeParams(timeRange);
      const params = new URLSearchParams({
        startDate,
        endDate,
        ...(policyId && { policyId }),
      });

      const [statsRes, eventsRes] = await Promise.all([
        fetch(`/api/v1/security/stats?${params}`),
        fetch(`/api/v1/security/events?${params}&limit=20`),
      ]);

      if (!statsRes.ok || !eventsRes.ok) {
        throw new Error(t('loadFailed'));
      }

      const [statsData, eventsData] = await Promise.all([
        statsRes.json(),
        eventsRes.json(),
      ]);

      setStats(statsData);
      setEvents(eventsData.events);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('unknownError'));
    } finally {
      setLoading(false);
    }
  }, [timeRange, policyId, getTimeRangeParams, t]);

  useEffect(() => {
    // 挂载/依赖变化时异步拉取安全数据，并起 30 秒轮询定时器。
    // setState 均在 await 之后触发，属正常数据加载副作用。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchData();
    // 自动刷新（每 30 秒）
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const filteredEvents = useMemo(() => {
    if (selectedSeverity === 'ALL') return events;
    return events.filter((e) => e.severity === selectedSeverity);
  }, [events, selectedSeverity]);

  if (loading && !stats) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-8 bg-bg-muted dark:bg-gray-700 rounded w-1/4" />
        <div className="grid grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 bg-bg-muted dark:bg-gray-700 rounded" />
          ))}
        </div>
        <div className="h-64 bg-bg-muted dark:bg-gray-700 rounded" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8">
        <p className="text-red-500 dark:text-red-400">{error}</p>
        <button
          onClick={fetchData}
          className="mt-4 text-primary dark:text-primary hover:underline"
        >
          {t('retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-fg dark:text-white">
          {t('title')}
        </h2>
        <div className="flex items-center gap-4">
          {/* Time Range Selector */}
          <div className="flex rounded-md shadow-sm">
            {(['1h', '24h', '7d', '30d'] as TimeRange[]).map((range) => (
              <button
                key={range}
                onClick={() => setTimeRange(range)}
                className={`px-3 py-1 text-sm font-medium first:rounded-l-md last:rounded-r-md border ${
                  timeRange === range
                    ? 'bg-primary text-white border-primary'
                    : 'bg-bg dark:bg-gray-800 text-fg dark:text-gray-300 border-border-strong dark:border-gray-600 hover:bg-bg-subtle dark:hover:bg-gray-700'
                }`}
              >
                {t(`timeRange.${range}`)}
              </button>
            ))}
          </div>
          {/* Refresh Button */}
          <button
            onClick={fetchData}
            disabled={loading}
            className="p-2 text-fg-muted hover:text-fg dark:text-fg-subtle dark:hover:text-gray-200"
          >
            <svg
              className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Total Events */}
          <div className="bg-bg dark:bg-gray-800 rounded-lg shadow p-4">
            <dt className="text-sm font-medium text-fg-muted dark:text-fg-subtle">{t('totalEvents')}</dt>
            <dd className="mt-1 text-3xl font-semibold text-fg dark:text-white">
              {formatSecurityCount(stats.total, locale)}
            </dd>
          </div>

          {/* Error Rate */}
          <div className="bg-bg dark:bg-gray-800 rounded-lg shadow p-4">
            <dt className="text-sm font-medium text-fg-muted dark:text-fg-subtle">{t('errorRate')}</dt>
            {/* R32 P0 fix：原 *-600 在 dark mode 下 contrast 不达标。
                统一 *-700/*-300 模式（light/dark）以满足 WCAG AA。 */}
            <dd className={`mt-1 text-3xl font-semibold ${
              stats.errorRate > 0.1
                ? 'text-red-700 dark:text-red-300'
                : stats.errorRate > 0.05
                  ? 'text-yellow-700 dark:text-yellow-300'
                  : 'text-green-700 dark:text-green-300'
            }`}>
              {formatSecurityPercentage(stats.errorRate, locale)}
            </dd>
          </div>

          {/* Warnings */}
          <div className="bg-bg dark:bg-gray-800 rounded-lg shadow p-4">
            <dt className="text-sm font-medium text-fg-muted dark:text-fg-subtle">{t('severity.WARNING')}</dt>
            <dd className="mt-1 text-3xl font-semibold text-yellow-700 dark:text-yellow-300">
              {formatSecurityCount(stats.bySeverity.WARNING, locale)}
            </dd>
          </div>

          {/* Errors + Critical */}
          <div className="bg-bg dark:bg-gray-800 rounded-lg shadow p-4">
            <dt className="text-sm font-medium text-fg-muted dark:text-fg-subtle">{t('errorsAndCritical')}</dt>
            <dd className="mt-1 text-3xl font-semibold text-red-700 dark:text-red-300">
              {formatSecurityCount(stats.bySeverity.ERROR + stats.bySeverity.CRITICAL, locale)}
            </dd>
          </div>
        </div>
      )}

      {/* Event Type Breakdown */}
      {stats && Object.keys(stats.byType).length > 0 && (
        <div className="bg-bg dark:bg-gray-800 rounded-lg shadow p-4">
          <h3 className="text-lg font-medium text-fg dark:text-white mb-4">{t('eventTypeBreakdown')}</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {Object.entries(stats.byType)
              .sort((a, b) => b[1] - a[1])
              .map(([type, count]) => (
                <div
                  key={type}
                  className="flex items-center justify-between p-2 bg-bg-subtle dark:bg-gray-700 rounded"
                >
                  <span className="text-sm text-fg dark:text-gray-300 truncate">
                    {eventTypeLabel(type)}
                  </span>
                  <span className="ml-2 text-sm font-medium text-fg dark:text-white">
                    {formatSecurityCount(count, locale)}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Recent Events */}
      <div className="bg-bg dark:bg-gray-800 rounded-lg shadow">
        <div className="px-4 py-3 border-b border-border dark:border-gray-700 flex items-center justify-between">
          <h3 className="text-lg font-medium text-fg dark:text-white">{t('recentEvents')}</h3>
          {/* Severity Filter */}
          <select
            value={selectedSeverity}
            onChange={(e) => setSelectedSeverity(e.target.value as EventSeverity | 'ALL')}
            className="text-sm border border-border-strong dark:border-gray-600 rounded-md px-2 py-1 bg-bg dark:bg-gray-700 text-fg dark:text-white"
          >
            <option value="ALL">{t('allSeverities')}</option>
            {(Object.keys(SEVERITY_CONFIG) as EventSeverity[]).map((severity) => (
              <option key={severity} value={severity}>{t(`severity.${severity}`)}</option>
            ))}
          </select>
        </div>
        <div className="divide-y divide-border dark:divide-gray-700 max-h-96 overflow-y-auto">
          {filteredEvents.length === 0 ? (
            <div className="p-8 text-center text-fg-muted dark:text-fg-subtle">
              {t('noEvents')}
            </div>
          ) : (
            filteredEvents.map((event) => (
              <div key={event.id} className="px-4 py-3 hover:bg-bg-subtle dark:hover:bg-gray-700">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                          SEVERITY_CONFIG[event.severity].bgColor
                        } ${SEVERITY_CONFIG[event.severity].color}`}
                      >
                        {t(`severity.${event.severity}`)}
                      </span>
                      <span className="text-sm font-medium text-fg dark:text-white">
                        {eventTypeLabel(securityEventDisplayType(event.eventType, event.details))}
                      </span>
                    </div>
                    <div className="mt-1 text-sm text-fg-muted dark:text-fg-subtle">
                      {event.policyId && (
                        <span className="mr-3">{t('policy')}: {event.policyId.slice(0, 8)}...</span>
                      )}
                      {event.ipAddress && (
                        <span className="mr-3">IP: {event.ipAddress}</span>
                      )}
                      {event.requestId && (
                        <span>{t('requestId')}: {event.requestId.slice(0, 8)}...</span>
                      )}
                    </div>
                    {/* Event Details */}
                    {Object.keys(event.details).length > 0 && (
                      <details className="mt-2">
                        <summary className="text-xs text-primary dark:text-primary cursor-pointer">
                          {t('viewDetails')}
                        </summary>
                        <pre className="mt-1 text-xs bg-bg-muted dark:bg-gray-900 p-2 rounded overflow-x-auto">
                          {JSON.stringify(event.details, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                  <div className="ml-4 text-sm text-fg-muted dark:text-fg-subtle whitespace-nowrap">
                    {new Date(event.createdAt).toLocaleString(locale)}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
