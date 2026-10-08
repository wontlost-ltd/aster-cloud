/**
 * 统一复核者形状（ADR 0041 §5.2）。
 *
 * 三个来源按 source 标注：
 * - policy-proof：PolicyProof（ADR 0037），身份来自 PolicyReviewer 授权记录 ⇒ roleVerified=true；
 * - version-approval：PolicyApproval 版本审批 ⇒ roleVerified=true；
 * - guard-approval：运行时 guard 审批，角色为调用方自报头 ⇒ roleVerified=false。
 *
 * 键一律是 PolicyVersion.id：Execution.policyVersionRowId、PolicyApproval.versionId、
 * PolicyProof.policyVersionId 三者同一 id 空间，无需映射。
 */
import { inArray } from 'drizzle-orm';
import { db, policyProofs, policyApprovals } from '@/lib/prisma';
import type { ChainApproval } from './receipts-client';

export type Reviewer = {
  userId: string;
  role: string;
  source: 'guard-approval' | 'policy-proof' | 'version-approval';
  outcome: string;
  decidedAt: string;
  ref: string;
  roleVerified: boolean;
};

function push(out: Map<string, Reviewer[]>, key: string, reviewer: Reviewer): void {
  const list = out.get(key) ?? [];
  list.push(reviewer);
  out.set(key, list);
}

/**
 * 按版本取 PolicyProof 复核者（每版本内每节点取最新结论）。
 *
 * ★租户前置条件：PolicyProof 表没有租户列，本函数不做租户过滤；
 * 调用方必须只传入取自「已按租户过滤的 executions」的 policyVersionRowId。
 */
export async function loadProofReviewers(policyVersionRowIds: string[]): Promise<Map<string, Reviewer[]>> {
  const out = new Map<string, Reviewer[]>();
  if (policyVersionRowIds.length === 0) return out;
  const rows = await db.query.policyProofs.findMany({
    where: inArray(policyProofs.policyVersionId, policyVersionRowIds),
    columns: {
      id: true, policyId: true, policyVersionId: true, nodeId: true,
      verdict: true, subjectKind: true, subjectUserId: true, createdAt: true,
    },
  });
  // append-only：撤销即追加，故每个版本内每 (policyId, nodeId) 只认 createdAt 最新的一条。
  // 键含 policyVersionId：proof 是对「某一版」做出的，新版本的结论不得覆盖旧版本执行的复核者（ADR 0041 §5.2）。
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const k = `${r.policyVersionId}\u0000${r.policyId}\u0000${r.nodeId}`;
    const cur = latest.get(k);
    if (!cur || r.createdAt > cur.createdAt) latest.set(k, r);
  }
  for (const r of latest.values()) {
    if (!r.policyVersionId) continue;
    push(out, r.policyVersionId, {
      userId: r.subjectUserId, role: r.subjectKind, source: 'policy-proof', outcome: r.verdict,
      decidedAt: r.createdAt.toISOString(), ref: r.id, roleVerified: true,
    });
  }
  return out;
}

/**
 * 按版本取 PolicyApproval 版本审批人。
 *
 * ★租户前置条件：PolicyApproval 表没有租户列，本函数不做租户过滤；
 * 调用方必须只传入取自「已按租户过滤的 executions」的 policyVersionRowId。
 */
export async function loadVersionApprovalReviewers(policyVersionRowIds: string[]): Promise<Map<string, Reviewer[]>> {
  const out = new Map<string, Reviewer[]>();
  if (policyVersionRowIds.length === 0) return out;
  const rows = await db.query.policyApprovals.findMany({
    where: inArray(policyApprovals.versionId, policyVersionRowIds),
    columns: { id: true, versionId: true, approverId: true, decision: true, createdAt: true },
  });
  for (const r of rows) {
    push(out, r.versionId, {
      userId: r.approverId, role: 'approver', source: 'version-approval', outcome: r.decision,
      decidedAt: r.createdAt.toISOString(), ref: r.id, roleVerified: true,
    });
  }
  return out;
}

/**
 * guard 审批角色取自自报请求头，尚未经服务端核验（3b 改为 true）。
 * 审批行未记 decidedBy / requiredRole 时与角色同口径标 'unknown'，不留空值。
 */
export function guardApprovalReviewers(approvals: ChainApproval[]): Reviewer[] {
  return approvals.map((a) => ({
    userId: a.decidedBy ?? 'unknown', role: a.requiredRole ?? 'unknown', source: 'guard-approval', outcome: a.outcome,
    decidedAt: a.decidedAt, ref: String(a.auditId), roleVerified: false,
  }));
}
