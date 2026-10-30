import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const routeActions = [
  ['src/app/api/api-keys/route.ts', 'API_KEY_CREATED'],
  ['src/app/api/api-keys/[id]/route.ts', 'API_KEY_REVOKED'],
  ['src/app/api/teams/route.ts', 'TEAM_CREATED'],
  ['src/app/api/teams/[teamId]/route.ts', 'TEAM_DELETED'],
  ['src/app/api/teams/[teamId]/transfer/route.ts', 'TEAM_OWNERSHIP_TRANSFERRED'],
  ['src/app/api/teams/[teamId]/members/[memberId]/route.ts', 'TEAM_MEMBER_REMOVED'],
  ['src/app/api/teams/[teamId]/members/[memberId]/route.ts', 'TEAM_MEMBER_BUSINESS_ROLES_UPDATED'],
  ['src/app/api/policies/[id]/route.ts', 'POLICY_TRASHED'],
  ['src/app/api/policies/trash/[id]/route.ts', 'POLICY_RESTORED'],
  ['src/app/api/policies/trash/[id]/route.ts', 'POLICY_PERMANENTLY_DELETED'],
  ['src/app/api/policies/trash/route.ts', 'POLICY_PERMANENTLY_DELETED'],
] as const;

describe('管理路由安全事件接线', () => {
  it.each(routeActions)('%s 在成功路径记录 %s', (routePath, action) => {
    const source = readFileSync(routePath, 'utf8');
    expect(source).toContain("from '@/services/security/security-event-service'");
    expect(source).toContain(`logSecurityAdminAction(session.user.id, '${action}'`);
  });
});
