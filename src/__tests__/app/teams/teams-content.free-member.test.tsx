/**
 * /teams 对个人套餐不含团队功能的成员（#672）：个人套餐只决定能否新建团队，
 * 已加入的团队与待处理邀请照常显示，新建入口换成升级入口；没有任何团队时才显示升级说明。
 */
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock('@/components/teams/pending-invitations-card', () => ({
  PendingInvitationsCard: () => <div data-testid="pending-invitations" />,
}));

import { TeamsContent } from '@/app/[locale]/(dashboard)/teams/teams-content';

const team = {
  id: 't1',
  name: 'Paid Team',
  slug: 'paid-team',
  role: 'member',
  memberCount: 2,
  policyCount: 3,
  createdAt: '2026-10-30T00:00:00.000Z',
};

describe('TeamsContent — Free 成员（#672）', () => {
  it('已加入的团队与待处理邀请照常显示，新建入口换成升级入口', () => {
    const html = renderToStaticMarkup(<TeamsContent initialTeams={[team]} canCreateTeam={false} />);
    expect(html).toContain('Paid Team');
    expect(html).toContain('href="/teams/t1"');
    expect(html).toContain('data-testid="pending-invitations"');
    expect(html).not.toContain('href="/teams/new"');
    expect(html).not.toContain('upgradeRequired.title');
  });

  it('没有任何团队时显示升级说明，邀请卡仍在', () => {
    const html = renderToStaticMarkup(<TeamsContent initialTeams={[]} canCreateTeam={false} />);
    expect(html).toContain('upgradeRequired.title');
    expect(html).toContain('data-testid="pending-invitations"');
    expect(html).not.toContain('href="/teams/new"');
  });

  it('个人套餐含团队功能时保留新建入口', () => {
    const html = renderToStaticMarkup(<TeamsContent initialTeams={[team]} canCreateTeam />);
    expect(html).toContain('href="/teams/new"');
    expect(html).not.toContain('upgradeRequired');
  });
});
