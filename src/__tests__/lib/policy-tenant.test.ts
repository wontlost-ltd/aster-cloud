// 策略租户 id 推导单测：执行路由写入与证据导出读取共用同一口径。

import { describe, it, expect } from 'vitest';
import { policyTenantId } from '@/lib/policy-tenant';

describe('policyTenantId', () => {
  it('团队策略取 teamId', () => {
    expect(policyTenantId({ teamId: 'team-1', userId: 'u-1' })).toBe('team-1');
  });

  it('teamId 为 null ⇒ 取 userId', () => {
    expect(policyTenantId({ teamId: null, userId: 'u-1' })).toBe('u-1');
  });

  it('★teamId 为空串 ⇒ 取 userId（与执行路由写入口径一致）', () => {
    expect(policyTenantId({ teamId: '', userId: 'u-1' })).toBe('u-1');
  });
});
