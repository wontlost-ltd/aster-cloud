'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { formatDate } from '@/lib/format';
import { SharedWithTeamSection } from '@/components/policy/shared-with-team-section';
import { Breadcrumbs, Container, PageHeader } from '@/components/ui';
import { extractErrorMessage } from '@/lib/api/error-envelope';

interface Policy {
  id: string;
  name: string;
  description: string | null;
  version: number;
  piiFields: string[] | null;
  createdBy: {
    id: string;
    name: string | null;
    email?: string | null;
  } | null;
  executionCount: number;
  createdAt: string;
  updatedAt: string;
}

interface Team {
  id: string;
  name: string;
  slug: string;
}

export default function TeamPoliciesPage() {
  const t = useTranslations('teams');
  const tPolicies = useTranslations('policies');
  const params = useParams();
  const teamId = params.teamId as string;
  const locale = params.locale as string;

  const [team, setTeam] = useState<Team | null>(null);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [userRole, setUserRole] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  // Inline create-policy form removed (was a separate process duplicate
  // of /policies/new). The "+ New policy" buttons below now link to
  // `/policies/new?teamId=<id>` which routes through the shared
  // PolicyForm + /api/policies POST. POLICY_CREATE permission is
  // checked server-side on that endpoint.

  const fetchData = useCallback(async () => {
    try {
      const [teamRes, policiesRes] = await Promise.all([
        fetch(`/api/teams/${teamId}`),
        fetch(`/api/teams/${teamId}/policies`),
      ]);

      if (!teamRes.ok) {
        const data = await teamRes.json();
        throw new Error(extractErrorMessage(data) || 'Failed to fetch team');
      }

      const teamData = await teamRes.json();
      setTeam(teamData.team);
      setUserRole(teamData.role);

      if (policiesRes.ok) {
        const policiesData = await policiesRes.json();
        setPolicies(policiesData.policies);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failedToLoad'));
    } finally {
      setIsLoading(false);
    }
  }, [teamId, t]);

  useEffect(() => {
    // 挂载时异步拉取团队与策略数据，setState 发生在 fetch 完成后的回调中（非渲染期同步），属合法的数据加载副作用。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchData();
  }, [fetchData]);

  const canCreatePolicy = userRole === 'owner' || userRole === 'admin' || userRole === 'member';

  if (isLoading) {
    return (
      <Container size="xl" className="py-6 sm:py-10">
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      </Container>
    );
  }

  if (!team) {
    return (
      <Container size="xl" className="py-6 sm:py-10">
        <div className="text-center py-12">
          <p className="text-red-600">{error || t('teamNotFound')}</p>
          <Link href="/teams" className="mt-4 text-primary hover:text-primary-hover">
            {t('backToTeams')}
          </Link>
        </div>
      </Container>
    );
  }

  return (
    <Container size="xl" className="py-6 sm:py-10">
      {/* deep 页：保留 Breadcrumbs（团队名→当前 Policies），放进 PageHeader breadcrumbs slot。
          原顶部 "返回团队" 链接由面包屑父级条目承担。 */}
      <PageHeader
        title={t('policies.title')}
        subtitle={team.name}
        breadcrumbs={
          <Breadcrumbs
            items={[
              { label: team.name, href: `/teams/${teamId}` },
              { label: t('policies.title') },
            ]}
          />
        }
        action={
          canCreatePolicy ? (
            // Routes through the shared /policies/new editor — see
            // page.tsx comment at the top. teamId in the query string
            // is read by NewPolicyContent and forwarded into the
            // POST /api/policies body.
            <Link
              href={`/policies/new?teamId=${teamId}`}
              className="inline-flex items-center rounded-md bg-primary px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-primary-hover"
            >
              <svg className="-ml-0.5 mr-1.5 h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
              </svg>
              {t('policies.newPolicy')}
            </Link>
          ) : undefined
        }
        className="mb-6"
      />

      {error && (
        <div className="mt-4 rounded-md bg-red-50 p-4">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* 策略列表 */}
      {policies.length === 0 ? (
        <div className="mt-8 text-center">
          <svg
            className="mx-auto h-12 w-12 text-fg-subtle"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          <h3 className="mt-2 text-sm font-semibold text-fg">{t('policies.noPolicies')}</h3>
          <p className="mt-1 text-sm text-fg-muted">{t('policies.getStarted')}</p>
          {canCreatePolicy && (
            <div className="mt-6">
              <Link
                href={`/policies/new?teamId=${teamId}`}
                className="inline-flex items-center rounded-md bg-primary px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-primary-hover"
              >
                <svg className="-ml-0.5 mr-1.5 h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
                </svg>
                {t('policies.newPolicy')}
              </Link>
            </div>
          )}
        </div>
      ) : (
        <div className="mt-8 overflow-hidden bg-bg shadow sm:rounded-md">
          <ul className="divide-y divide-border">
            {policies.map((policy) => (
              <li key={policy.id}>
                <div className="px-4 py-4 sm:px-6 hover:bg-bg-subtle">
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <Link href={`/policies/${policy.id}`} className="block">
                        <p className="text-sm font-medium text-primary truncate hover:underline">
                          {policy.name}
                        </p>
                        {policy.description && (
                          <p className="mt-1 text-sm text-fg-muted truncate">
                            {policy.description}
                          </p>
                        )}
                      </Link>
                    </div>
                    <div className="ml-4 flex items-center space-x-4">
                      {/* PII 标签 */}
                      {policy.piiFields && policy.piiFields.length > 0 && (
                        <span className="inline-flex items-center rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-medium text-yellow-800">
                          {tPolicies('piiFields', { count: policy.piiFields.length })}
                        </span>
                      )}

                      {/* 执行次数 */}
                      <span className="text-sm text-fg-muted">
                        {t('policies.executionCount', { count: policy.executionCount })}
                      </span>

                      {/* 版本 */}
                      <span className="text-xs text-fg-subtle">v{policy.version}</span>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <div className="text-xs text-fg-subtle">
                      {policy.createdBy && (
                        <span>
                          {t('policies.createdBy', {
                            name: policy.createdBy.name || policy.createdBy.email || t('policies.unknownCreator'),
                          })}
                          {' · '}
                        </span>
                      )}
                      {t('policies.updatedAt', {
                        date: formatDate(policy.updatedAt, locale),
                      })}
                    </div>
                    <div className="flex items-center space-x-2">
                      <Link
                        href={`/policies/${policy.id}/execute`}
                        className="text-primary hover:text-primary-active text-sm"
                      >
                        {tPolicies('executeAction')}
                      </Link>
                      <Link
                        href={`/policies/${policy.id}`}
                        className="text-fg-muted hover:text-fg text-sm"
                      >
                        {t('viewDetails')}
                      </Link>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Policies shared *with* this team. Self-gates: returns nothing
          when sharing is off or no shares exist. */}
      <SharedWithTeamSection teamId={teamId} locale={locale} />
    </Container>
  );
}
