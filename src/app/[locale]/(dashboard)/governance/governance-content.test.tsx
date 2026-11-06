/*
 * 治理视图（#739）：框架 → 控制项 → 策略的展开、active 徽标与版本列表、未登记键分组、未关联桶与空态。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));
vi.mock('@/components/ui', () => ({
  Badge: ({ children, variant }: { children: React.ReactNode; variant?: string }) => <span data-variant={variant}>{children}</span>,
  Breadcrumbs: () => null,
  Card: ({ children, ...rest }: React.HTMLAttributes<HTMLDivElement>) => <section {...rest}>{children}</section>,
  CardBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  Container: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
  Stack: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import { GovernanceContent } from './governance-content';
import type { GovernanceOverview, ImpactPolicy } from '@/lib/governance-impact';

const title = (en: string, zh: string) => ({ en, zh, de: en });

function policy(id: string, over: Partial<ImpactPolicy> = {}): ImpactPolicy {
  return {
    id, name: `Policy ${id}`, teamId: 'team1', teamName: 'Team One', active: true,
    versions: [{ version: 1, status: 'APPROVED', isDefault: true }],
    executions30d: 0, pendingApprovals: 0,
    ...over,
  };
}

const overview: GovernanceOverview = {
  registryVersion: '1.1.0',
  frameworks: [
    {
      id: 'EU_AI_ACT', title: title('EU AI Act', '欧盟人工智能法'),
      controls: [{
        key: 'EU_AI_ACT:ART14', article: '14', title: title('Human oversight', '人工监督'),
        policies: [
          policy('p1', { executions30d: 3, pendingApprovals: 2, versions: [
            { version: 1, status: 'APPROVED', isDefault: true },
            { version: 2, status: 'DRAFT', isDefault: false },
          ] }),
          policy('p2', { active: false, teamId: null, teamName: null, versions: [{ version: 1, status: 'APPROVED', isDefault: false }] }),
        ],
      }],
    },
    {
      id: 'GDPR', title: title('GDPR', '通用数据保护条例'),
      controls: [{ key: 'GDPR:ART6', article: '6', title: title('Lawfulness', '合法性'), policies: [] }],
    },
  ],
  unregistered: [{ key: 'ACME:ART1', policies: [policy('p3', { active: false, versions: [{ version: 1, status: 'DRAFT', isDefault: false }] })] }],
  unlinked: [{ id: 'p4', name: 'Policy p4', teamId: 'team1', teamName: 'Team One', executions30d: 7, pendingApprovals: 1 }],
  unparsed: [{ policyId: 'p1', version: 3, diagnostics: ['E064'] }, { policyId: 'p9', version: 1, diagnostics: ['E056'] }],
};

afterEach(cleanup);

describe('GovernanceContent', () => {
  it('按 locale 渲染框架与控制项标题、注册表版本', () => {
    render(<GovernanceContent locale="zh" overview={overview} />);
    expect(screen.getByText('欧盟人工智能法')).toBeTruthy();
    expect(screen.getByText('人工监督')).toBeTruthy();
    expect(screen.getByTestId('registry-version').textContent).toBe('registryVersion:{"version":"1.1.0"}');
    expect(screen.getByText('article:{"article":"14"}')).toBeTruthy();
  });

  it('控制项下列出策略：链接、团队 / 个人、active 徽标、版本、执行数与待审批数', () => {
    render(<GovernanceContent locale="en" overview={overview} />);
    const row = within(screen.getByTestId('impact-row-p1'));
    expect(row.getByRole('link', { name: 'Policy p1' }).getAttribute('href')).toBe('/policies/p1');
    expect(row.getByText('Team One')).toBeTruthy();
    expect(row.getByText('active')).toBeTruthy();
    expect(row.getByText('v1 · versionStatus.APPROVED · defaultVersion')).toBeTruthy();
    expect(row.getByText('v2 · versionStatus.DRAFT')).toBeTruthy();
    expect(row.getByText('3')).toBeTruthy();
    expect(row.getByText('2')).toBeTruthy();

    const personal = within(screen.getByTestId('impact-row-p2'));
    expect(personal.getByText('personal')).toBeTruthy();
    expect(personal.getByText('inactive')).toBeTruthy();
  });

  it('无策略引用的控制项显示空提示与 0 计数', () => {
    render(<GovernanceContent locale="en" overview={overview} />);
    const control = within(screen.getByTestId('control-GDPR:ART6'));
    expect(control.getByText('noPolicies')).toBeTruthy();
    expect(control.getByText('policyCount:{"count":0}')).toBeTruthy();
  });

  it('未登记键单独分组，未关联策略单列', () => {
    render(<GovernanceContent locale="en" overview={overview} />);
    const unregistered = within(screen.getByTestId('unregistered'));
    expect(unregistered.getByText('ACME:ART1')).toBeTruthy();
    expect(unregistered.getByTestId('impact-row-p3')).toBeTruthy();

    const unlinked = within(screen.getByTestId('unlinked-row-p4'));
    expect(unlinked.getByRole('link', { name: 'Policy p4' }).getAttribute('href')).toBe('/policies/p4');
    expect(unlinked.getByText('7')).toBeTruthy();
    expect(unlinked.getByText('1')).toBeTruthy();
  });

  it('无法解析的版本单列：能反查到名字的用名字，否则显示 id，并链接到版本页', () => {
    render(<GovernanceContent locale="en" overview={overview} />);
    const known = within(screen.getByTestId('unparsed-p1-3'));
    expect(known.getByRole('link', { name: 'Policy p1' }).getAttribute('href')).toBe('/policies/p1/versions');
    expect(known.getByText('E064')).toBeTruthy();
    expect(within(screen.getByTestId('unparsed-p9-1')).getByRole('link', { name: 'p9' })).toBeTruthy();
  });

  it('没有未登记键 / 未解析版本时不渲染这两组；没有未关联策略时显示空态', () => {
    render(<GovernanceContent locale="en" overview={{ ...overview, unregistered: [], unlinked: [], unparsed: [] }} />);
    expect(screen.queryByTestId('unregistered')).toBeNull();
    expect(screen.queryByTestId('unparsed')).toBeNull();
    expect(within(screen.getByTestId('unlinked')).getByText('unlinked.empty')).toBeTruthy();
  });
});
