'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { canViewInvitations, teamLoadError } from './team-fetch';
import { Breadcrumbs, Container, PageHeader } from '@/components/ui';

interface Team {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

interface Member {
  id: string;
  role: string;
  user: {
    id: string;
    name: string | null;
    email: string;
  };
  joinedAt: string;
}

interface Policy {
  id: string;
  name: string;
  description: string | null;
  executionCount: number;
  updatedAt: string;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
}

export default function TeamDashboardPage() {
  const t = useTranslations('teams');
  const params = useParams();
  const teamId = params.teamId as string;

  const [team, setTeam] = useState<Team | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [pendingInvitations, setPendingInvitations] = useState<Invitation[]>([]);
  const [userRole, setUserRole] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchTeamData = useCallback(async () => {
    try {
      // 并行获取所有数据
      const [teamRes, membersRes, policiesRes] = await Promise.all([
        fetch(`/api/teams/${teamId}`),
        fetch(`/api/teams/${teamId}/members`),
        fetch(`/api/teams/${teamId}/policies`),
      ]);

      if (!teamRes.ok) {
        const data = await teamRes.json().catch(() => null);
        throw new Error(teamLoadError(teamRes.status, data, t));
      }

      const teamData = await teamRes.json();
      setTeam(teamData.team);
      setUserRole(teamData.role);
      // 邀请列表按角色决定是否请求（见 team-fetch.ts）
      const invitationsRes = canViewInvitations(teamData.role)
        ? await fetch(`/api/teams/${teamId}/invitations`)
        : null;

      if (membersRes.ok) {
        const membersData = await membersRes.json();
        setMembers(membersData.members);
      }

      if (policiesRes.ok) {
        const policiesData = await policiesRes.json();
        setPolicies(policiesData.policies);
      }

      if (invitationsRes?.ok) {
        const invitationsData = await invitationsRes.json();
        setPendingInvitations(invitationsData.invitations);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failedToLoad'));
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  }, [teamId, t]);

  useEffect(() => {
    // 挂载时拉取团队/成员/策略/邀请数据（异步数据加载的规范用法），故意在 effect 内触发 set
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchTeamData();
  }, [fetchTeamData]);

  const canManageSettings = userRole === 'owner' || userRole === 'admin';

  if (isLoading) {
    return (
      <Container size="xl" className="py-6 sm:py-10">
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      </Container>
    );
  }

  if (error) {
    return (
      <Container size="xl" className="py-6 sm:py-10">
        <div className="text-center py-12">
          <div className="rounded-md bg-red-50 p-4 max-w-md mx-auto">
            <p className="text-sm text-red-700">{error}</p>
          </div>
          <Link
            href="/teams"
            className="mt-4 inline-flex items-center text-sm text-primary hover:text-primary-hover"
          >
            <svg className="h-4 w-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            {t('backToTeams')}
          </Link>
        </div>
      </Container>
    );
  }

  if (!team) return null;

  return (
    <Container size="xl" className="py-6 sm:py-10">
      {/* 深层页：保留面包屑（Teams → 当前团队），放进 PageHeader 的 breadcrumbs slot。 */}
      <PageHeader
        title={team.name}
        subtitle={`/${team.slug}`}
        breadcrumbs={
          <Breadcrumbs
            items={[{ label: t('title'), href: '/teams' }, { label: team.name }]}
          />
        }
        action={
          canManageSettings ? (
            <Link
              href={`/teams/${teamId}/settings`}
              className="inline-flex items-center rounded-md border border-border-strong bg-bg px-3 py-2 text-sm font-medium text-fg shadow-sm hover:bg-bg-subtle"
            >
              <svg className="-ml-0.5 mr-1.5 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              {/*
                Was t('settings') — but `teams.settings` is a
                namespace (object), not a leaf string. use-intl's
                strict formatter throws INSUFFICIENT_PATH on a non-
                leaf path. The short button label lives at
                `teams.dashboard.settings` ("Settings"); the longer
                `teams.settings.title` is "Team settings" — wrong tone
                for an icon-prefixed action button.
              */}
              {t('dashboard.settings')}
            </Link>
          ) : undefined
        }
        className="mb-6"
      />

      {/* 快速导航卡片 */}
      <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {/* 成员卡片 */}
        <Link
          href={`/teams/${teamId}/members`}
          className="block bg-bg rounded-lg shadow hover:shadow-md transition-shadow p-6"
        >
          <div className="flex items-center">
            <div className="flex-shrink-0 p-3 bg-blue-100 rounded-lg">
              <svg className="h-6 w-6 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <div className="ml-4">
              <h3 className="text-lg font-medium text-fg">{t('dashboard.members')}</h3>
              <p className="text-2xl font-bold text-fg">{members.length}</p>
            </div>
          </div>
          {pendingInvitations.length > 0 && (
            <p className="mt-3 text-sm text-amber-600">
              {t('dashboard.pendingInvitations', { count: pendingInvitations.length })}
            </p>
          )}
        </Link>

        {/* 策略卡片 */}
        <Link
          href={`/teams/${teamId}/policies`}
          className="block bg-bg rounded-lg shadow hover:shadow-md transition-shadow p-6"
        >
          <div className="flex items-center">
            <div className="flex-shrink-0 p-3 bg-green-100 rounded-lg">
              <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div className="ml-4">
              <h3 className="text-lg font-medium text-fg">{t('dashboard.policies')}</h3>
              <p className="text-2xl font-bold text-fg">{policies.length}</p>
            </div>
          </div>
        </Link>

        {/* 设置卡片 */}
        {canManageSettings && (
          <Link
            href={`/teams/${teamId}/settings`}
            className="block bg-bg rounded-lg shadow hover:shadow-md transition-shadow p-6"
          >
            <div className="flex items-center">
              <div className="flex-shrink-0 p-3 bg-accent-subtle rounded-lg">
                <svg className="h-6 w-6 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </div>
              <div className="ml-4">
                <h3 className="text-lg font-medium text-fg">{t('dashboard.settings')}</h3>
                <p className="text-sm text-fg-muted">{t('dashboard.manageTeam')}</p>
              </div>
            </div>
          </Link>
        )}
      </div>

      {/* 最近成员 */}
      <div className="mt-8">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium text-fg">{t('dashboard.recentMembers')}</h2>
          <Link
            href={`/teams/${teamId}/members`}
            className="text-sm text-primary hover:text-primary-hover"
          >
            {t('viewAll')}
          </Link>
        </div>
        <div className="mt-4 bg-bg shadow rounded-lg overflow-hidden">
          <ul className="divide-y divide-border">
            {members.slice(0, 5).map((member) => (
              <li key={member.id} className="px-4 py-3 flex items-center justify-between">
                <div className="flex items-center">
                  <div className="w-8 h-8 rounded-full bg-primary-subtle flex items-center justify-center">
                    <span className="text-primary text-sm font-medium">
                      {(member.user.name || member.user.email).charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div className="ml-3">
                    <p className="text-sm font-medium text-fg">
                      {member.user.name || member.user.email}
                    </p>
                    {member.user.name && (
                      <p className="text-xs text-fg-muted">{member.user.email}</p>
                    )}
                  </div>
                </div>
                <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-bg-muted text-fg">
                  {t(`roles.${member.role}`)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* 最近策略 */}
      {policies.length > 0 && (
        <div className="mt-8">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium text-fg">{t('dashboard.recentPolicies')}</h2>
            <Link
              href={`/teams/${teamId}/policies`}
              className="text-sm text-primary hover:text-primary-hover"
            >
              {t('viewAll')}
            </Link>
          </div>
          <div className="mt-4 bg-bg shadow rounded-lg overflow-hidden">
            <ul className="divide-y divide-border">
              {policies.slice(0, 5).map((policy) => (
                <li key={policy.id} className="px-4 py-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-primary">{policy.name}</p>
                      {policy.description && (
                        <p className="text-xs text-fg-muted truncate max-w-md">{policy.description}</p>
                      )}
                    </div>
                    <span className="text-xs text-fg-muted">
                      {t('executions', { count: policy.executionCount })}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Container>
  );
}
