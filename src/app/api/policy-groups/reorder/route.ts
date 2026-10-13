import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { db, policyGroups, teamMembers } from '@/lib/prisma';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { wouldCreateParentCycle } from '@/lib/policy-group-hierarchy';
import { lookupGroupParent } from '@/lib/policy-group-parent-lookup';

// POST /api/policy-groups/reorder - 批量更新分组排序
export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { orders } = await req.json();

    if (!Array.isArray(orders) || orders.length === 0) {
      return NextResponse.json({ error: 'Orders array is required' }, { status: 400 });
    }

    // 验证所有分组都属于当前用户或其团队
    //
    // ★ parentId 必须与 id 一同校验：它同样是一个分组 ID，且会被直接写入
    //   （见下方 updateData.parentId）。此前只校验 orders[].id，导致攻击者可用
    //   自己的分组作为 id、把受害者的分组 ID 塞进 parentId，将自己的分组挂到
    //   对方的分组树下。policyGroups.parentId 是裸 text 列、无 FK 无约束，
    //   DB 不会兜底；而 DELETE [id] 的级联按 parentId 改写且**无 owner 谓词**，
    //   受害者删除分组时会连带改写攻击者的行（反之亦然）。
    const orderIds = orders.map((o: { id: string }) => o.id);
    const parentIds = orders
      .map((o: { parentId?: string | null }) => o.parentId)
      .filter((p: string | null | undefined): p is string => typeof p === 'string' && p.length > 0);
    const groupIds = Array.from(new Set<string>([...orderIds, ...parentIds]));

    // 查询用户自己的分组
    const userGroups = await db.query.policyGroups.findMany({
      where: and(
        inArray(policyGroups.id, groupIds),
        eq(policyGroups.userId, session.user.id)
      ),
      columns: { id: true, isSystem: true },
    });

    // 查询用户作为owner/admin的团队分组
    const adminTeams = await db.query.teamMembers.findMany({
      where: and(
        eq(teamMembers.userId, session.user.id),
        sql`${teamMembers.role} IN ('owner', 'admin')`
      ),
      columns: { teamId: true },
    });

    const adminTeamIds = adminTeams.map(t => t.teamId);
    const teamGroups = adminTeamIds.length > 0
      ? await db.query.policyGroups.findMany({
          where: and(
            inArray(policyGroups.id, groupIds),
            inArray(policyGroups.teamId, adminTeamIds)
          ),
          columns: { id: true, isSystem: true },
        })
      : [];

    const groups = [...userGroups, ...teamGroups];

    // 检查是否所有请求的分组都找到了
    const foundIds = new Set(groups.map((g) => g.id));
    const notFoundIds = groupIds.filter((id: string) => !foundIds.has(id));
    if (notFoundIds.length > 0) {
      return NextResponse.json(
        { error: `Groups not found or no permission: ${notFoundIds.join(', ')}` },
        { status: 404 }
      );
    }

    // 检查是否有系统分组（只针对被**改写**的分组；作为 parent 引用系统分组是允许的）
    const orderIdSet = new Set<string>(orderIds);
    const systemGroups = groups.filter((g) => g.isSystem && orderIdSet.has(g.id));
    if (systemGroups.length > 0) {
      return NextResponse.json({ error: 'Cannot reorder system groups' }, { status: 403 });
    }

    // 父子关系不得成环（#478）：PUT 路径一直有这条校验，reorder 一次能改多个 parentId，
    // 曾可用 [{id: A, parentId: B}, {id: B, parentId: A}] 直接造出 A↔B。按整批改动一起判断。
    const parentEdits = new Map<string, string | null>(
      (orders as Array<{ id: string; parentId?: string | null }>)
        .filter((o) => o.parentId !== undefined)
        .map((o) => [o.id, o.parentId || null]),
    );
    if (await wouldCreateParentCycle(parentEdits, lookupGroupParent)) {
      return NextResponse.json({ error: 'Cannot move group to its own descendant' }, { status: 400 });
    }

    // 批量更新排序
    await db.transaction(async (tx) => {
      for (const order of orders as Array<{ id: string; sortOrder: number; parentId?: string }>) {
        const updateData: { sortOrder: number; parentId?: string | null } = {
          sortOrder: order.sortOrder,
        };
        if (order.parentId !== undefined) {
          updateData.parentId = order.parentId || null;
        }
        await tx.update(policyGroups).set(updateData).where(eq(policyGroups.id, order.id));
      }
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error reordering policy groups:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
