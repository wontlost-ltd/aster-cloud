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
});
