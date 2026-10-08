/**
 * 策略所属租户 id：与 aster-api 的 X-Tenant-Id 口径一致——团队策略取 teamId，个人策略取所有者 userId。
 * 用 `||` 而非 `??`：teamId 为空串视同无团队，执行写入与证据导出读取必须落在同一租户。
 */
export function policyTenantId(policy: { teamId: string | null; userId: string }): string {
  return policy.teamId || policy.userId;
}
