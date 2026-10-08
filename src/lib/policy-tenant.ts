/**
 * 策略所属租户 id：与 aster-api 的 X-Tenant-Id 口径一致——团队策略取 teamId，个人策略取所有者 userId。
 * 用 `||` 而非 `??`：teamId 为空串视同无团队，执行写入与证据导出读取必须落在同一租户。
 */
export function policyTenantId(policy: { teamId: string | null; userId: string }): string {
  return policy.teamId || policy.userId;
}

/**
 * 是否个人租户：个人租户 id 即其所有者 userId（与 policyTenantId 的口径一致）。
 * 业务角色读取与待审批收件人判定共用此规则，避免两处判定漂移。
 */
export function isPersonalTenant(tenantId: string, userId: string): boolean {
  return tenantId === userId;
}
