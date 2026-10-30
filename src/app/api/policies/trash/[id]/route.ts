import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { restorePolicy, permanentDeletePolicy } from '@/lib/policy-lifecycle';
import { invalidatePolicyCache } from '@/lib/cache';
import { logSecurityAdminAction } from '@/services/security/security-event-service';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/policies/trash/[id] - Restore a policy from trash
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    const result = await restorePolicy(id, session.user.id);

    if (!result.success) {
      return NextResponse.json({ error: result.error, code: result.code }, { status: result.status ?? 404 });
    }

    // 响应前完成缓存失效；KV 故障只记录，不把已成功的写操作报成失败。
    await invalidatePolicyCache(result.policyId ?? id).catch((err) => console.warn('[Cache] Failed to invalidate policy cache:', err));
    await logSecurityAdminAction(session.user.id, 'POLICY_RESTORED', {
      policyId: result.policyId,
    });

    return NextResponse.json({
      success: true,
      policyId: result.policyId,
      nameConflict: result.nameConflict,
      newName: result.newName,
      message: result.nameConflict
        ? `Policy restored with new name: ${result.newName}`
        : 'Policy restored successfully',
    });
  } catch (error) {
    console.error('Error restoring policy:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/policies/trash/[id] - Permanently delete a policy
export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    const result = await permanentDeletePolicy(id, session.user.id);

    if (!result.success) {
      return NextResponse.json({ error: result.error, code: result.code }, { status: result.status ?? 404 });
    }

    await logSecurityAdminAction(session.user.id, 'POLICY_PERMANENTLY_DELETED', { policyId: id });

    return NextResponse.json({
      success: true,
      message: 'Policy permanently deleted',
    });
  } catch (error) {
    console.error('Error permanently deleting policy:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
