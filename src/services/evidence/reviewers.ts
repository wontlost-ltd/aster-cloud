/**
 * 统一复核者形状（ADR 0041 §5.2）。
 *
 * 三个来源按 source 标注：
 * - policy-proof：PolicyProof（ADR 0037），身份来自 PolicyReviewer 授权记录 ⇒ roleVerified=true；
 * - version-approval：PolicyApproval 版本审批 ⇒ roleVerified=true；
 * - guard-approval：运行时 guard 审批，角色由 aster-api 对照成员已授予的业务角色验证（ADR 0042 §2.3）⇒ roleVerified=true。
 *
 * 键一律是 PolicyVersion.id：Execution.policyVersionRowId、PolicyApproval.versionId、
 * PolicyProof.policyVersionId 三者同一 id 空间，无需映射。
 */
import { inArray } from 'drizzle-orm';
import { db, policyProofs, policyApprovals } from '@/lib/prisma';
import type { ChainApproval } from './receipts-client';

/** schemaVersion 2–5 冻结形状：只用于读取已持久化的历史导出，不得修改。 */
export type ReviewerV5 = {
  userId: string;
  role: string;
  source: 'guard-approval' | 'policy-proof' | 'version-approval';
  outcome: string;
  decidedAt: string;
  ref: string;
  roleVerified: boolean;
};

/**
 * v6 复核者（ADR 0042 §12 D9）：在 v5 形状上增审批快照四键。
 * 只有 guard-approval 来源取收据接口 approvals[] 的值；旧 api、旧事件与过期事件没有这些键，归一为 null。
 * 版本级来源（policy-proof / version-approval）不经过审批输入视图，四键恒为 null。
 * inputSnapshotMatched=true 只证明提交审批的客户端持有与当前视图一致的哈希，不证明人读过（ADR 0042 §11 D3 证明边界）。
 */
export type Reviewer = ReviewerV5 & {
  inputSnapshotHash: string | null;
  inputSnapshotMatched: boolean | null;
  inputRevealed: boolean | null;
  inputStatus: string | null;
};

/** 非 guard 来源的四个快照字段。 */
const NO_SNAPSHOT = { inputSnapshotHash: null, inputSnapshotMatched: null, inputRevealed: null, inputStatus: null } as const;

function push(out: Map<string, Reviewer[]>, key: string, reviewer: Reviewer): void {
  const list = out.get(key) ?? [];
  list.push(reviewer);
  out.set(key, list);
}

/** (createdAt, id) 字典序比较：时间相同则 id 码点序大者为新。 */
function isNewerProof(a: { createdAt: Date; id: string }, b: { createdAt: Date; id: string }): boolean {
  const dt = a.createdAt.getTime() - b.createdAt.getTime();
  return dt !== 0 ? dt > 0 : a.id > b.id;
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
  // append-only：撤销即追加，故每个版本内每 (policyId, nodeId) 只认按 (createdAt, id) 最新的一条。
  // 同毫秒写入时以 id 码点序决胜，与查库返回顺序无关，保证两次导出 bundleHash 一致。
  // 键含 policyVersionId：proof 是对「某一版」做出的，新版本的结论不得覆盖旧版本执行的复核者（ADR 0041 §5.2）。
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const k = `${r.policyVersionId}\u0000${r.policyId}\u0000${r.nodeId}`;
    const cur = latest.get(k);
    if (!cur || isNewerProof(r, cur)) latest.set(k, r);
  }
  for (const r of latest.values()) {
    if (!r.policyVersionId) continue;
    push(out, r.policyVersionId, {
      userId: r.subjectUserId, role: r.subjectKind, source: 'policy-proof', outcome: r.verdict,
      decidedAt: r.createdAt.toISOString(), ref: r.id, roleVerified: true, ...NO_SNAPSHOT,
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
      decidedAt: r.createdAt.toISOString(), ref: r.id, roleVerified: true, ...NO_SNAPSHOT,
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
    decidedAt: a.decidedAt, ref: String(a.auditId), roleVerified: true,
    inputSnapshotHash: a.inputSnapshotHash, inputSnapshotMatched: a.inputSnapshotMatched,
    inputRevealed: a.inputRevealed, inputStatus: a.inputStatus,
  }));
}
