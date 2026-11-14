/**
 * aster-api 端点版本管理
 *
 * 集中管理所有 aster-api 的 REST 端点路径。
 * 修改 API_VERSION 即可切换所有端点的版本前缀。
 */

export const API_VERSION = 'v1';

const prefix = `/api/${API_VERSION}`;

export const API_ENDPOINTS = {
  // 策略评估
  evaluate: `${prefix}/policies/evaluate`,
  evaluateBatch: `${prefix}/policies/evaluate/batch`,
  evaluateSource: `${prefix}/policies/evaluate-source`,
  compile: `${prefix}/policies/compile`,
  schema: `${prefix}/policies/schema`,
  // 导出为 Cedar（ADR 0047 §6）：端点要求已验证身份，request() 自动附内部签名
  exportCedar: `${prefix}/policies/export/cedar`,
  /**
   * What-If 批次（ADR 0034）。★路径含 policyId，故用函数而非常量——
   * 签名时只取 pathname（不含 query），与 InternalCallerFilter 的
   * ctx.getUriInfo().getPath() 对齐。
   */
  whatIfBatches: (policyId: string) => `${prefix}/policies/${policyId}/whatif-batches`,
  whatIfBatch: (policyId: string, batchId: string) =>
    `${prefix}/policies/${policyId}/whatif-batches/${batchId}`,
  moduleCatalog: `${prefix}/modules/catalog`,

  /**
   * Action Guard（ADR 0042 §4.2）。整个 /guard/ 前缀走内部 HMAC v3 签名；
   * id 只出现在 path 段，签名取 pathname，与 InternalCallerFilter 一致。
   */
  guardPrefix: `${prefix}/guard/`,
  guardFromEvidence: `${prefix}/guard/decisions/from-evidence`,
  guardDecision: (id: string) => `${prefix}/guard/decisions/${encodeURIComponent(id)}`,
  guardApprovals: `${prefix}/guard/approvals`,
  guardApprovalAction: (id: string, action: 'approve' | 'reject') =>
    `${prefix}/guard/approvals/${encodeURIComponent(id)}/${action}`,
  /** 审批输入视图与解除（ADR 0042 §12 D8）。 */
  guardApprovalInput: (id: string) => `${prefix}/guard/approvals/${encodeURIComponent(id)}/input`,
  guardApprovalInputReveal: (id: string) => `${prefix}/guard/approvals/${encodeURIComponent(id)}/input/reveal`,
  /**
   * 签名事实签发方（ADR 0040 §11 D3）。issuer / kid 须先过 isFactIssuerSegment：合规段全是 URL 非保留字符，
   * encodeURIComponent 不改变它们，签名取的 pathname 与 api 解码后的 path 逐字相同。
   */
  guardFactIssuers: `${prefix}/guard/fact-issuers`,
  guardFactIssuer: (issuer: string, kid: string) =>
    `${prefix}/guard/fact-issuers/${encodeURIComponent(issuer)}/${encodeURIComponent(kid)}`,

  /** cloud 策略部署到 aster-api Guard（ADR 0054 §11 D1）：cloud 策略 id 为 cuid / uuid，URL 安全。 */
  guardPolicyDeployment: (cloudPolicyId: string) =>
    `${prefix}/guard/policy-deployments/${encodeURIComponent(cloudPolicyId)}`,

  // 健康检查
  healthLive: '/q/health/live',
  healthReady: '/q/health/ready',

  // 审计
  audit: `${prefix}/audit`,

  // Workflow
  workflows: `${prefix}/workflows`,

  // AI Assistant
  aiGenerate: `${prefix}/ai/generate`,
  aiExplain: `${prefix}/ai/explain`,
  aiComplete: `${prefix}/ai/complete`,
  aiSuggest: `${prefix}/ai/suggest`,
} as const;

export type ApiEndpoint = keyof typeof API_ENDPOINTS;
