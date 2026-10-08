/**
 * 按当前用户实时装配 PolicyApiClient（ADR 0042 §4.4）。
 *
 * 业务角色每次请求现查（loadBusinessRoles），不缓存：授予/撤销后下一次调用即生效，
 * 角色随内部 HMAC v3 签名下发，aster-api 只信任签过的集合。
 */
import 'server-only';

import { loadBusinessRoles } from '@/lib/business-roles';
import { PolicyApiClient } from '@/services/policy/policy-api';

export async function createPolicyApiClientForUser(
  tenantId: string,
  userId: string,
  userRole = 'member'
): Promise<PolicyApiClient> {
  const roles = await loadBusinessRoles(userId, tenantId);
  return new PolicyApiClient(tenantId, userId, userRole, 'unknown', roles);
}
