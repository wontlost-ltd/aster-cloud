import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { db, policyGroups, policies, teamMembers } from '@/lib/prisma';
import { eq, and, inArray, isNull } from 'drizzle-orm';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/policy-groups/[id]/policies - 批量添加策略到分组
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: groupId } = await params;
    const { policyIds } = await req.json();

    if (!Array.isArray(policyIds) || policyIds.length === 0) {
      return NextResponse.json({ error: 'Policy IDs array is required' }, { status: 400 });
    }

    // 验证分组存在且用户有权限
    let group = await db.query.policyGroups.findFirst({
      where: eq(policyGroups.id, groupId),
    });

    if (!group) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 });
    }

    // 检查用户权限
    const hasPermission = group.userId === session.user.id ||
      (group.teamId && await db.query.teamMembers.findFirst({
        where: and(
          eq(teamMembers.teamId, group.teamId),
          eq(teamMembers.userId, session.user.id)
        ),
      }));

    if (!hasPermission) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 });
    }

    // 验证所有策略都属于当前用户
    const userPolicies = await db.query.policies.findMany({
      where: and(
        inArray(policies.id, policyIds),
        eq(policies.userId, session.user.id),
        isNull(policies.deletedAt)
      ),
      columns: { id: true },
    });

    const foundIds = new Set(userPolicies.map((p) => p.id));
    const notFoundIds = policyIds.filter((id: string) => !foundIds.has(id));

    if (notFoundIds.length > 0) {
      return NextResponse.json(
        { error: `Policies not found: ${notFoundIds.join(', ')}` },
        { status: 404 }
      );
    }

    // 批量更新策略的分组
    //
    // ★2026-08-17 审计留档：这里**刻意不改写 policies.teamId**。
    //
    //   「个人策略（teamId=null）躺在团队分组里」这一混合状态，是 DELETE 级联
    //   跨租户写的成因（分组归属与策略归属两套口径分叉）。一个看似自然的收敛做法
    //   是在此处把 teamId 对齐成 group.teamId——但那会造成**更严重的隐私回归**：
    //   policies.teamId 是团队可见性的授权键（见 /api/v1/policies/route.ts:57
    //   的 inArray(policies.teamId, teamIds)、/api/teams/[teamId]/policies），
    //   自动写入等于把用户的私有策略静默共享给整个团队。
    //
    //   因此保持数据语义不变，改在**消费侧**用「我拥有的 OR 我所在团队的」
    //   并集谓词处理这一合法状态（见 policy-groups/[id]/route.ts），
    //   并在删除级联中用「重定位受限 + 解引用不受限」的两段式消除安全后果。
    await db
      .update(policies)
      .set({ groupId })
      .where(and(
        inArray(policies.id, policyIds),
        eq(policies.userId, session.user.id)
      ));

    return NextResponse.json({
      success: true,
      count: policyIds.length,
    });
  } catch (error) {
    console.error('Error adding policies to group:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/policy-groups/[id]/policies - 批量从分组移除策略
export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: groupId } = await params;
    const { policyIds } = await req.json();

    if (!Array.isArray(policyIds) || policyIds.length === 0) {
      return NextResponse.json({ error: 'Policy IDs array is required' }, { status: 400 });
    }

    // 验证分组存在且用户有权限
    let group = await db.query.policyGroups.findFirst({
      where: eq(policyGroups.id, groupId),
    });

    if (!group) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 });
    }

    // 检查用户权限
    const hasPermission = group.userId === session.user.id ||
      (group.teamId && await db.query.teamMembers.findFirst({
        where: and(
          eq(teamMembers.teamId, group.teamId),
          eq(teamMembers.userId, session.user.id)
        ),
      }));

    if (!hasPermission) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 });
    }

    // 批量移除策略的分组关联（设为 null）
    await db
      .update(policies)
      .set({ groupId: null })
      .where(and(
        inArray(policies.id, policyIds),
        eq(policies.userId, session.user.id),
        eq(policies.groupId, groupId)
      ));

    return NextResponse.json({
      success: true,
      count: policyIds.length,
    });
  } catch (error) {
    console.error('Error removing policies from group:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
