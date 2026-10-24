import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { restorePolicy, permanentDeletePolicy } from '@/lib/policy-lifecycle';
import { invalidatePolicyCache } from '@/lib/cache';

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
      return NextResponse.json({ error: result.error }, { status: 404 });
    }

    await invalidatePolicyCache(id);

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
      return NextResponse.json({ error: result.error }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      message: 'Policy permanently deleted',
    });
  } catch (error) {
    console.error('Error permanently deleting policy:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
