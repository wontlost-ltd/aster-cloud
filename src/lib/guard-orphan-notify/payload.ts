// 孤儿通知载荷的客户端安全助手：不得引入 server-only 或数据库依赖，铃铛组件会直接引用。

/** 通知跳转链接：带租户与 critical 过滤；租户 id 缺失时退回对账总览。 */
export function orphanNoticeHref(tenantId: string): string {
  if (!tenantId) return '/governance/reconciliation';
  return `/governance/reconciliation?tenant=${encodeURIComponent(tenantId)}&severity=critical`;
}
