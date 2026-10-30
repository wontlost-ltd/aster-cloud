// 通知铃铛文案渲染：占位符以函数替换，用户数据中的 `$&` / `$'` 等替换模式按字面输出。
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/i18n/navigation', () => ({ Link: () => null }));

import { fillTemplate, renderText } from '@/components/notifications/notifications-bell';

type Row = Parameters<typeof renderText>[0];
type Labels = Parameters<typeof renderText>[1];

const labels = {
  policyShared: '{policyName} shared with {teamName} ({permission})',
  guardApprovalRequested: 'Approval requested: {policyName}',
  guardApprovalDecided: '{policyName} was {outcome}',
  guardOutcomeApproved: 'approved',
  guardOutcomeRejected: 'rejected',
  permissionView: 'view',
  permissionExecute: 'execute',
  versionSubmitted: '{policyName} v{version} needs approval',
  versionApproved: '{policyName} v{version} was approved',
  versionRejected: '{policyName} v{version} was rejected: {comment}',
  versionRejectedNoComment: '{policyName} v{version} was rejected',
} as unknown as Labels;

function row(kind: string, data: Record<string, unknown>): Row {
  return { id: 'n1', kind, data, readAt: null, createdAt: '2026-10-09T00:00:00Z' };
}

describe('notifications-bell 文案渲染', () => {
  it('fillTemplate：替换模式字符按字面保留', () => {
    expect(fillTemplate('a {x} b', { x: "$& $' $` $$" })).toBe("a $& $' $` $$ b");
  });

  it('guard 待审批 / 已决通知：策略名含 $& 原样显示', () => {
    expect(renderText(row('guard.approval_requested', { policyName: 'Refund $& $\'' }), labels).text)
      .toBe("Approval requested: Refund $& $'");
    expect(renderText(row('guard.approval_decided', { policyName: 'P$&', outcome: 'REJECTED' }), labels).text)
      .toBe('P$& was rejected');
  });

  it('policy.shared：策略名与团队名含替换模式原样显示', () => {
    const text = renderText(row('policy.shared', { policyName: '$`x', teamName: "T$'", permission: 'view' }), labels).text;
    expect(text).toBe("$`x shared with T$' (view)");
  });

  it('策略版本提交审批 → 审批收件箱（#678）', () => {
    const r = renderText(row('policy.version_submitted', { policyId: 'p1', policyName: 'Loan', version: 2 }), labels);
    expect(r).toEqual({ text: 'Loan v2 needs approval', href: '/approvals' });
  });

  it('策略版本驳回带理由，链接到版本页（#678）', () => {
    const r = renderText(
      row('policy.version_decided', { policyId: 'p1', policyName: 'Loan', version: 2, outcome: 'REJECTED', comment: 'too risky' }),
      labels,
    );
    expect(r).toEqual({ text: 'Loan v2 was rejected: too risky', href: '/policies/p1/versions' });
    expect(
      renderText(row('policy.version_decided', { policyId: 'p1', policyName: 'Loan', version: 2, outcome: 'REJECTED' }), labels).text,
    ).toBe('Loan v2 was rejected');
    expect(
      renderText(row('policy.version_decided', { policyId: 'p1', policyName: 'Loan', version: 3, outcome: 'APPROVED' }), labels).text,
    ).toBe('Loan v3 was approved');
  });
});
