import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getTrashItems, getTrashStats, emptyTrash } from '@/lib/policy-lifecycle';
import { logSecurityAdminAction } from '@/services/security/security-event-service';

// GET /api/policies/trash - List all policies in trash
export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const [items, stats] = await Promise.all([
      getTrashItems(session.user.id),
      getTrashStats(session.user.id),
    ]);

    return NextResponse.json({
      items,
      stats,
    });
  } catch (error) {
    console.error('Error fetching trash:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/policies/trash - Empty trash (permanently delete all)
export async function DELETE() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const result = await emptyTrash(session.user.id);

    if (result.errors.length > 0) {
      console.error('Empty trash errors:', result.errors);
    }

    if (result.deletedCount > 0) {
      await logSecurityAdminAction(session.user.id, 'POLICY_PERMANENTLY_DELETED', {
        deletedCount: result.deletedCount,
        source: 'EMPTY_TRASH',
      });
    }

    return NextResponse.json({
      success: true,
      deletedCount: result.deletedCount,
      errors: result.errors.length > 0 ? result.errors : undefined,
    });
  } catch (error) {
    console.error('Error emptying trash:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
