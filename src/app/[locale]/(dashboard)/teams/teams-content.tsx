'use client';

import { useMemo, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { Container, PageHeader, ListSearchInput } from '@/components/ui';
import { CLIENT_CAPABILITIES } from '@/hooks/use-deployment-mode';
import { PendingInvitationsCard } from '@/components/teams/pending-invitations-card';

interface Team {
  id: string;
  name: string;
  slug: string;
  role: string;
  memberCount: number;
  policyCount: number;
  createdAt: string;
}

interface TeamsContentProps {
  initialTeams: Team[];
  /** 个人套餐是否含团队功能：只决定能否新建团队，不影响查看已加入的团队与邀请（#672）。 */
  canCreateTeam: boolean;
}

/** 新建团队入口：个人套餐不含团队功能时换成升级入口（on-prem 由 license 决定，提示联系管理员）。 */
function CreateTeamAction({ canCreateTeam }: { canCreateTeam: boolean }) {
  const t = useTranslations('teams');
  if (canCreateTeam) {
    return (
      <Link
        href="/teams/new"
        className="inline-flex items-center rounded-md bg-primary px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-primary-hover"
      >
        <svg className="-ml-0.5 mr-1.5 h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
          <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
        </svg>
        {t('newTeam')}
      </Link>
    );
  }
  return CLIENT_CAPABILITIES.billing ? (
    <Link
      href="/billing"
      className="inline-flex items-center rounded-md bg-primary px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-primary-hover"
    >
      {t('upgradeRequired.upgradeButton')}
    </Link>
  ) : (
    <span className="inline-flex items-center rounded-md bg-bg-subtle px-3 py-2 text-sm font-medium text-fg-muted">
      {t('upgradeRequired.contactAdmin')}
    </span>
  );
}

export function TeamsContent({
  initialTeams,
  canCreateTeam,
}: TeamsContentProps) {
  // i18n via useTranslations directly — drops the prerender prop pattern.
  const t = useTranslations('teams');
  const tCommon = useTranslations('common');

  const [teams] = useState<Team[]>(initialTeams);
  const [error] = useState('');
  const [query, setQuery] = useState('');

  const visibleTeams = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return teams;
    return teams.filter((t) => t.name.toLowerCase().includes(q));
  }, [teams, query]);

  const getRoleBadgeColor = (role: string) => {
    switch (role) {
      case 'owner':
        return 'bg-accent-subtle text-accent-hover';
      case 'admin':
        return 'bg-blue-100 text-blue-800';
      case 'member':
        return 'bg-green-100 text-green-800';
      case 'viewer':
        return 'bg-bg-muted text-fg';
      default:
        return 'bg-bg-muted text-fg';
    }
  };

  const getRoleLabel = (role: string) => t(`roles.${role}` as 'roles.owner');

  return (
    <Container size="xl" className="py-6 sm:py-10">
      {/* 顶层页：去 Breadcrumbs（sidebar 高亮 + PageHeader h1 已显页名）。 */}
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        className="mb-6"
        action={<CreateTeamAction canCreateTeam={canCreateTeam} />}
      />

      {/* In-app inbox: invitations addressed to the current user's
          email. Self-hides when empty, so users with nothing pending
          don't see a permanent "Pending invitations (0)" header. */}
      <div className="mt-6">
        <PendingInvitationsCard />
      </div>

      {teams.length > 0 && (
        <div className="mt-6">
          <ListSearchInput
            value={query}
            onChange={setQuery}
            placeholder={tCommon('searchPlaceholder')}
          />
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-md bg-red-50 p-4">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {teams.length === 0 ? (
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
              d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
            />
          </svg>
          {canCreateTeam ? (
            <>
              <h3 className="mt-2 text-sm font-semibold text-fg">{t('noTeams')}</h3>
              <p className="mt-1 text-sm text-fg-muted">{t('getStarted')}</p>
            </>
          ) : (
            <>
              <h3 className="mt-2 text-sm font-semibold text-fg">{t('upgradeRequired.title')}</h3>
              <p className="mt-1 text-sm text-fg-muted">{t('upgradeRequired.description')}</p>
            </>
          )}
          <div className="mt-6">
            <CreateTeamAction canCreateTeam={canCreateTeam} />
          </div>
        </div>
      ) : (
        <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {visibleTeams.map((team) => (
            <Link
              key={team.id}
              href={`/teams/${team.id}`}
              className="block bg-bg rounded-lg shadow hover:shadow-md transition-shadow"
            >
              <div className="p-6">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold text-fg">{team.name}</h3>
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${getRoleBadgeColor(team.role)}`}
                  >
                    {getRoleLabel(team.role)}
                  </span>
                </div>
                <p className="mt-1 text-sm text-fg-muted">/{team.slug}</p>
                <div className="mt-4 flex items-center space-x-4 text-sm text-fg-muted">
                  <div className="flex items-center">
                    <svg className="h-4 w-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                    {t('memberCount', { count: team.memberCount })}
                  </div>
                  <div className="flex items-center">
                    <svg className="h-4 w-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    {t('policyCount', { count: team.policyCount })}
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </Container>
  );
}
