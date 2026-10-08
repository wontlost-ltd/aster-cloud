// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// server-only 由 Next 构建期别名提供（未作为依赖安装），测试中以空模块替代。
vi.mock('server-only', () => ({}));

const loadBusinessRoles = vi.fn();
vi.mock('@/lib/business-roles', () => ({
  loadBusinessRoles: (userId: string, tenantId: string) => loadBusinessRoles(userId, tenantId),
}));

const ctor = vi.fn();
vi.mock('@/services/policy/policy-api', () => ({
  PolicyApiClient: class {
    constructor(...args: unknown[]) {
      ctor(...args);
    }
  },
}));

import { createPolicyApiClientForUser } from '@/lib/policy-api-identity';

describe('createPolicyApiClientForUser', () => {
  beforeEach(() => {
    loadBusinessRoles.mockReset();
    ctor.mockReset();
  });

  it('实时查该租户的业务角色并作为第 5 参传入', async () => {
    loadBusinessRoles.mockResolvedValue(['DPO', 'CISO']);
    await createPolicyApiClientForUser('team1', 'u-1');
    expect(loadBusinessRoles).toHaveBeenCalledWith('u-1', 'team1');
    expect(ctor).toHaveBeenCalledWith('team1', 'u-1', 'member', 'unknown', ['DPO', 'CISO']);
  });

  it('透传 userRole；无角色时传空数组', async () => {
    loadBusinessRoles.mockResolvedValue([]);
    await createPolicyApiClientForUser('u-1', 'u-1', 'admin');
    expect(ctor).toHaveBeenCalledWith('u-1', 'u-1', 'admin', 'unknown', []);
  });
});
