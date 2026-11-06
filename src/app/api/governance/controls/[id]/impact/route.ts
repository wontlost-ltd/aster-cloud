import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { isControlKey, loadControlImpact } from '@/lib/governance-impact';

// GET /api/governance/controls/[id]/impact — 引用该 @control 键的策略（#739）。
// 只列调用方可见的策略（本人个人策略 + 本人当前可查看的团队策略），回收站里的不出现。
// 未登记的键照样查询（registry 为 null），形态非法的键 400。
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const control = decodeURIComponent(id);
  if (!isControlKey(control)) {
    return NextResponse.json({ error: 'invalid_control_key', code: 'INVALID_CONTROL_KEY' }, { status: 400 });
  }

  return NextResponse.json(await loadControlImpact(session.user.id, control));
}
