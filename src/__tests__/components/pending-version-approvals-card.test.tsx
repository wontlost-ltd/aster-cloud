// @vitest-environment jsdom
/**
 * #774：仪表盘「等待你审批的策略版本」卡片——没有待办不渲染；有待办时以标题命名为 region，
 * 徽标给总数，首屏最多 5 条，每条有直达版本页的「Review」入口。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

import { PendingVersionApprovalsCard } from '@/components/dashboard/pending-version-approvals-card';

const labels = {
  title: 'Policy versions awaiting your review', subtitle: 's', review: 'Review',
  submittedBy: 'Submitted by {name}', unknownUser: 'Unknown user', viewAll: 'All approvals',
};
const item = (n: number) => ({ versionId: `v${n}`, policyId: 'p1', policyName: 'Loan', version: n, submittedBy: n === 1 ? null : 'UI Member' });

describe('PendingVersionApprovalsCard (#774)', () => {
  it('renders nothing without pending approvals', () => {
    const { container } = render(<PendingVersionApprovalsCard items={[]} labels={labels} />);
    expect(container.innerHTML).toBe('');
  });

  it('is a named region with a count and a Review link per item, capped at five', () => {
    render(<PendingVersionApprovalsCard items={[1, 2, 3, 4, 5, 6, 7].map(item)} labels={labels} />);
    const region = screen.getByRole('region', { name: labels.title });
    expect(within(region).getByText('7')).toBeTruthy();
    const links = within(region).getAllByRole('link', { name: /^Review:/ });
    expect(links).toHaveLength(5);
    expect(links[0].getAttribute('href')).toBe('/policies/p1/versions');
    expect(within(region).getByText('Submitted by Unknown user')).toBeTruthy();
    expect(within(region).getByRole('link', { name: /All approvals/ }).getAttribute('href')).toBe('/approvals');
  });
});
