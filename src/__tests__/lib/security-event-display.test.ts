import { describe, it, expect } from 'vitest';
import { securityEventDisplayType } from '@/lib/security-event-display';

/**
 * 安全事件展示类型（F10）：同一 eventType 下语义不同的动作必须分开标注。
 * 生产缺陷：作者「提交审批」（APPROVAL_DECISION + action=SUBMIT_FOR_APPROVAL）
 * 在列表与类型分布里都显示成「审批决策」。
 */
describe('securityEventDisplayType', () => {
  it('提交审批不是审批决策', () => {
    expect(
      securityEventDisplayType('APPROVAL_DECISION', { action: 'SUBMIT_FOR_APPROVAL' }),
    ).toBe('APPROVAL_SUBMITTED');
  });

  it('真正的审批决定保持 APPROVAL_DECISION', () => {
    expect(securityEventDisplayType('APPROVAL_DECISION', { decision: 'APPROVED' } as never)).toBe(
      'APPROVAL_DECISION',
    );
  });

  it('执行失败（error 字段或 success=false）单独标注', () => {
    expect(securityEventDisplayType('POLICY_EXECUTED', { error: 'boom' })).toBe(
      'POLICY_EXECUTION_FAILED',
    );
    expect(securityEventDisplayType('POLICY_EXECUTED', { success: false })).toBe(
      'POLICY_EXECUTION_FAILED',
    );
    expect(securityEventDisplayType('POLICY_EXECUTED', { success: true })).toBe('POLICY_EXECUTED');
  });

  it('其余类型与缺失 details 原样返回', () => {
    expect(securityEventDisplayType('VERSION_CREATED', null)).toBe('VERSION_CREATED');
    expect(securityEventDisplayType('NONCE_REUSED', undefined)).toBe('NONCE_REUSED');
  });

  it('管理操作按 details.action 显示具体事件类型', () => {
    const actions = [
      'API_KEY_CREATED', 'API_KEY_REVOKED', 'TEAM_CREATED', 'TEAM_DELETED',
      'TEAM_OWNERSHIP_TRANSFERRED', 'TEAM_MEMBER_REMOVED', 'POLICY_TRASHED',
      'POLICY_RESTORED', 'POLICY_PERMANENTLY_DELETED',
    ];
    for (const action of actions) {
      expect(securityEventDisplayType('VERSION_CREATED', { action })).toBe(action);
    }
  });
});
