/*
 * In-app notification writer + reader helpers.
 *
 * Notifications are deliberately fire-and-forget on the writer side —
 * a failure to write a notification must never break the operation
 * that triggered it (creating a team invitation, accepting one).
 * Callers wrap in their own try/catch and log via console.error if
 * they care.
 *
 * Reader side returns a normalized view used by both the topbar bell
 * (unread count + tiny list) and any future inbox surface.
 */

import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { db, notifications } from '@/lib/prisma';

/**
 * Strongly-typed kinds. Add a new kind here when you add a new
 * notification source so callers can't typo into the void.
 */
export type NotificationKind =
  | 'team.invitation_received'
  | 'team.invitation_accepted'
  | 'policy.shared'
  | 'guard.approval_requested'
  | 'guard.approval_decided';

/** guard 审批通知的共同载荷（ADR 0042 §5.3）：requiredRole 为 null 表示 ESCALATE（任意成员可审）。 */
export interface GuardApprovalNotification {
  tenantId: string;
  decisionId: string;
  approvalId: string;
  policyId: string;
  policyName: string;
  requiredRole: string | null;
  /** 仅 approval_decided 携带：审批结论。 */
  outcome?: 'APPROVED' | 'REJECTED';
}

export interface NotificationPayloads {
  'team.invitation_received': {
    teamId: string;
    teamName: string;
    invitationId: string;
    role: string;
  };
  'team.invitation_accepted': {
    teamId: string;
    teamName: string;
    /** Display name of the user who accepted. */
    memberName: string;
  };
  'policy.shared': {
    policyId: string;
    policyName: string;
    teamId: string;
    teamName: string;
    /** Permission tier the share was granted at — view or execute. */
    permission?: 'view' | 'execute';
  };
  'guard.approval_requested': GuardApprovalNotification;
  'guard.approval_decided': GuardApprovalNotification;
}

/**
 * Append a notification for a user. Returns the id on success,
 * `null` on failure (does not throw). The caller logs the error.
 */
export async function createNotification<K extends NotificationKind>(params: {
  userId: string;
  kind: K;
  data: NotificationPayloads[K];
}): Promise<string | null> {
  try {
    const id = globalThis.crypto.randomUUID();
    await db.insert(notifications).values({
      id,
      userId: params.userId,
      kind: params.kind,
      data: params.data,
      readAt: null,
      createdAt: new Date(),
    });
    return id;
  } catch (err) {
    // Notifications are non-critical — never bubble up. The error
    // lands in the Worker log for triage; the caller's flow
    // (e.g. accept-invitation) continues.
    console.error('[notifications] insert failed', {
      userId: params.userId,
      kind: params.kind,
      err,
    });
    return null;
  }
}

/**
 * Read a user's notifications. Defaults to the most recent 20 — the
 * bell only renders a compact list, full history needs a future
 * dedicated /notifications surface.
 */
export async function listNotifications(
  userId: string,
  opts: { limit?: number; unreadOnly?: boolean } = {},
): Promise<
  Array<{
    id: string;
    kind: string;
    data: unknown;
    readAt: string | null;
    createdAt: string;
  }>
> {
  const limit = Math.max(1, Math.min(50, opts.limit ?? 20));
  const where = opts.unreadOnly
    ? and(eq(notifications.userId, userId), isNull(notifications.readAt))
    : eq(notifications.userId, userId);
  const rows = await db.query.notifications.findMany({
    where,
    orderBy: [desc(notifications.createdAt)],
    limit,
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    data: r.data as unknown,
    readAt: r.readAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Returns the unread-count for a user. Cheap aggregate so the bell
 * can poll it on a short interval without dragging the full list.
 *
 * We bound the count at 50 so a runaway notification source (bug)
 * doesn't drag the count query — UI shows "50+" past that anyway.
 */
export async function countUnreadNotifications(userId: string): Promise<number> {
  const since = new Date(0);
  const rows = await db.query.notifications.findMany({
    where: and(
      eq(notifications.userId, userId),
      isNull(notifications.readAt),
      gt(notifications.createdAt, since),
    ),
    columns: { id: true },
    limit: 50,
  });
  return rows.length;
}

/** Mark a single notification or all-of-user as read. */
export async function markNotificationsRead(
  userId: string,
  opts: { id?: string },
): Promise<void> {
  const now = new Date();
  if (opts.id) {
    await db
      .update(notifications)
      .set({ readAt: now })
      .where(
        and(eq(notifications.userId, userId), eq(notifications.id, opts.id)),
      );
  } else {
    // Mark-all-read: useful when the user opens the bell drop-down.
    await db
      .update(notifications)
      .set({ readAt: now })
      .where(
        and(eq(notifications.userId, userId), isNull(notifications.readAt)),
      );
  }
}

/** Remove a notification (dismiss / decline). */
export async function dismissNotification(
  userId: string,
  id: string,
): Promise<void> {
  await db
    .delete(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.id, id)));
}
