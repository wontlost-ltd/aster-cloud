/**
 * UI 审计（#774）的角色夹具：播种脚本与 Playwright 审计用例共用同一份定义。
 * 匿名访问不在此表（不需要会话），由审计用例单独处理。
 */
export const AUDIT_TEAM_ID = 'ui-audit-team';

export interface AuditRole {
  id: string;
  name: string;
  email: string;
  plan: 'free' | 'pro' | 'team';
  isAdmin: boolean;
  teamRole?: 'owner' | 'admin' | 'member';
}

export const AUDIT_ROLES: readonly AuditRole[] = [
  { id: 'ui-free', name: 'UI Free', email: 'ui-free@ui-audit.test', plan: 'free', isAdmin: false },
  { id: 'ui-pro', name: 'UI Pro', email: 'ui-pro@ui-audit.test', plan: 'pro', isAdmin: false },
  { id: 'ui-owner', name: 'UI Owner', email: 'ui-owner@ui-audit.test', plan: 'team', isAdmin: false, teamRole: 'owner' },
  { id: 'ui-teamadmin', name: 'UI Team Admin', email: 'ui-teamadmin@ui-audit.test', plan: 'pro', isAdmin: false, teamRole: 'admin' },
  { id: 'ui-member', name: 'UI Member', email: 'ui-member@ui-audit.test', plan: 'free', isAdmin: false, teamRole: 'member' },
  { id: 'ui-platform', name: 'UI Platform Admin', email: 'ui-platform@ui-audit.test', plan: 'pro', isAdmin: true },
];
