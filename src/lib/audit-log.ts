/**
 * 审计日志辅助库
 *
 * 为高风险操作提供结构化审计日志记录。
 * 所有操作自动记录用户 ID、时间戳和上下文信息。
 */

import { db, auditLogs } from '@/lib/prisma';

export type AuditAction =
  | 'policy.create'
  | 'policy.update'
  | 'policy.delete'
  | 'policy.execute'
  | 'policy.publish'
  | 'policy.archive'
  | 'team.create'
  | 'team.member.add'
  | 'team.member.remove'
  | 'team.transfer'
  | 'subscription.upgrade'
  | 'subscription.downgrade'
  | 'subscription.cancelled'
  | 'api-key.create'
  | 'api-key.revoke'
  // BYOK（用户自带 AI key）管理——高风险，须管理员可追溯/审计。metadata 只存
  // provider / keyHint（后 4 位）/ 改动字段名与旧新值，**绝不**记录明文 key 或密文。
  | 'ai-key.create'
  | 'ai-key.update'
  | 'ai-key.reset-quota'
  | 'ai-key.reorder'
  | 'ai-key.delete'
  // 管理员手动熔断 / 解除 AI 成本熔断器（admin-only，F18）。
  | 'ai-circuit.trip'
  | 'ai-circuit.release'
  | 'user.delete'
  | 'settings.update'
  | 'payment.succeeded'
  | 'payment.failed'
  | 'lexicon.term.add'
  | 'lexicon.term.modify'
  | 'lexicon.term.delete'
  | 'lexicon.term.restore'
  // Docs surface (Phase 2 docs UX) — writes once when a logged-in
  // reader clicks a cross-domain CTA in /docs into the app surface.
  // Metadata holds { cta_id, target, locale }; never echoes PII.
  | 'docs.jump';

interface AuditEntry {
  userId: string;
  action: AuditAction;
  resource: string;
  resourceId?: string;
  teamId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * 记录审计日志
 */
export async function logAuditEvent(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      id: globalThis.crypto.randomUUID(),
      userId: entry.userId,
      teamId: entry.teamId,
      action: entry.action,
      resource: entry.resource,
      resourceId: entry.resourceId,
      metadata: entry.metadata,
      ipAddress: entry.ipAddress,
      userAgent: entry.userAgent,
    });
  } catch (error) {
    // 审计日志写入失败不应阻断主流程
    console.error('Failed to write audit log:', error);
  }
}

/**
 * 从请求中提取客户端信息
 */
export function extractClientInfo(request: Request): {
  ipAddress: string | undefined;
  userAgent: string | undefined;
} {
  return {
    ipAddress: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
               request.headers.get('cf-connecting-ip') || undefined,
    userAgent: request.headers.get('user-agent') || undefined,
  };
}
