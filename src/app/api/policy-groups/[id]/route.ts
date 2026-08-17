import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { db, policyGroups, policies, teamMembers } from '@/lib/prisma';
import { eq, and, or, isNull, sql, desc, inArray } from 'drizzle-orm';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/policy-groups/[id] - 获取单个分组详情
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    // 先查用户自己的分组或系统分组
    let group = await db.query.policyGroups.findFirst({
      where: and(
        eq(policyGroups.id, id),
        sql`(${policyGroups.userId} = ${session.user.id} OR ${policyGroups.isSystem} = true)`
      ),
    });

    // 如果不是用户的分组,检查是否是团队分组
    if (!group) {
      const userTeams = await db.query.teamMembers.findMany({
        where: eq(teamMembers.userId, session.user.id),
        columns: { teamId: true },
      });

      if (userTeams.length > 0) {
        const teamIds = userTeams.map(m => m.teamId);
        group = await db.query.policyGroups.findFirst({
          where: and(
            eq(policyGroups.id, id),
            inArray(policyGroups.teamId, teamIds)
          ),
        });
      }
    }

    if (!group) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 });
    }

    // ★安全审计修复（2026-08-17）：分组内的策略必须按调用者可见范围过滤。
    //
    // 此前本路由的策略查询只按 groupId 过滤、**不带任何归属谓词**。而上方第一道门
    // 允许 `isSystem = true` 通过——系统分组是**全局共享的单一行**（PolicyGroup.userId
    // 可空，系统分组按 isSystem 而非按用户查），因此任何登录用户都能通过那道门，
    // 进而读到全平台所有用户归档在该系统分组下的策略与全局计数。
    //
    // 正确口径同仓已有两处成文：
    //   - src/lib/policies.ts:216 「a system group's count is the number of *this user's*
    //     policies in it, not the global one」
    //   - 兄弟路由 [id]/policies/route.ts 的权限判定只认 owner/team，**不认 isSystem**
    //
    // ★谓词必须只依赖**已强制的**不变量。
    //   数据模型**不保证**「团队分组内的策略必有相同 teamId」：
    //   [id]/policies/route.ts 的赋值只写 groupId、从不写 teamId，
    //   因此成员把个人策略（teamId=null）放进团队分组是合法且常见的。
    //   若按 `eq(policies.teamId, group.teamId)` 过滤，这些合法策略会凭空消失
    //   （GET 查不到、DELETE 也不迁移 → 留下悬挂 groupId）。
    //   故取「我拥有的 OR 我所在团队的」并集——这是实际被强制的可见性边界。
    const policyScope = group.teamId
      ? or(eq(policies.userId, session.user.id), eq(policies.teamId, group.teamId))
      : eq(policies.userId, session.user.id);
    const childScope = group.teamId
      ? or(eq(policyGroups.userId, session.user.id), eq(policyGroups.teamId, group.teamId))
      : eq(policyGroups.userId, session.user.id);

    // 获取子分组（同样按归属过滤，避免泄露他人的子分组树）
    const children = await db.query.policyGroups.findMany({
      where: and(
        eq(policyGroups.parentId, id),
        childScope
      ),
      orderBy: [sql`${policyGroups.sortOrder} ASC`, sql`${policyGroups.name} ASC`],
    });

    // 为每个子分组获取策略计数
    const childrenWithCount = await Promise.all(
      children.map(async (child) => {
        const [{ count }] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(policies)
          .where(and(
            eq(policies.groupId, child.id),
            policyScope,
            isNull(policies.deletedAt)
          ));

        return {
          ...child,
          _count: { policies: count },
        };
      })
    );

    // 获取当前分组的策略
    const groupPolicies = await db.query.policies.findMany({
      where: and(
        eq(policies.groupId, id),
        policyScope,
        isNull(policies.deletedAt)
      ),
      orderBy: desc(policies.updatedAt),
      columns: {
        id: true,
        name: true,
        description: true,
        updatedAt: true,
      },
    });

    // 获取计数（同样按归属过滤：系统分组的计数是**本用户**在其中的策略数，非全局数）
    const [policyCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(policies)
      .where(and(
        eq(policies.groupId, id),
        policyScope,
        isNull(policies.deletedAt)
      ));

    const [childrenCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(policyGroups)
      .where(and(
        eq(policyGroups.parentId, id),
        childScope
      ));

    return NextResponse.json({
      ...group,
      children: childrenWithCount,
      policies: groupPolicies,
      _count: {
        policies: policyCount.count,
        children: childrenCount.count,
      },
    });
  } catch (error) {
    console.error('Error fetching policy group:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PUT /api/policy-groups/[id] - 更新分组
export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const { name, description, icon, parentId, sortOrder } = await req.json();

    // 验证分组存在且用户有权限
    // 先查用户自己的分组
    let existingGroup = await db.query.policyGroups.findFirst({
      where: and(
        eq(policyGroups.id, id),
        eq(policyGroups.userId, session.user.id)
      ),
    });

    // 如果不是用户的分组,检查团队权限(owner/admin)
    if (!existingGroup) {
      const adminTeams = await db.query.teamMembers.findMany({
        where: and(
          eq(teamMembers.userId, session.user.id),
          sql`${teamMembers.role} IN ('owner', 'admin')`
        ),
        columns: { teamId: true },
      });

      if (adminTeams.length > 0) {
        const adminTeamIds = adminTeams.map(t => t.teamId);
        existingGroup = await db.query.policyGroups.findFirst({
          where: and(
            eq(policyGroups.id, id),
            inArray(policyGroups.teamId, adminTeamIds)
          ),
        });
      }
    }

    if (!existingGroup) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 });
    }

    // 系统分组不允许修改
    if (existingGroup.isSystem) {
      return NextResponse.json({ error: 'Cannot modify system group' }, { status: 403 });
    }

    // 如果要修改父分组，验证不会造成循环引用
    if (parentId !== undefined && parentId !== existingGroup.parentId) {
      if (parentId === id) {
        return NextResponse.json({ error: 'Group cannot be its own parent' }, { status: 400 });
      }

      // 检查新父分组是否是当前分组的子孙
      if (parentId) {
        const isDescendant = await checkIsDescendant(id, parentId);
        if (isDescendant) {
          return NextResponse.json(
            { error: 'Cannot move group to its own descendant' },
            { status: 400 }
          );
        }
      }
    }

    // 构建更新数据
    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (icon !== undefined) updateData.icon = icon;
    if (parentId !== undefined) updateData.parentId = parentId || null;
    if (sortOrder !== undefined) updateData.sortOrder = sortOrder;

    const [group] = await db
      .update(policyGroups)
      .set(updateData)
      .where(eq(policyGroups.id, id))
      .returning();

    // 获取策略计数（★口径必须与 GET / 集合端点一致：只数调用者可见的策略。
    // 否则团队管理员会从 PUT 响应里拿到含他人个人策略的聚合数，
    // 造成与新隔离语义不一致的计数泄露。）
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(policies)
      .where(and(
        eq(policies.groupId, group.id),
        group.teamId
          ? or(eq(policies.userId, session.user.id), eq(policies.teamId, group.teamId))
          : eq(policies.userId, session.user.id),
        isNull(policies.deletedAt)
      ));

    return NextResponse.json({ ...group, _count: { policies: count } });
  } catch (error) {
    console.error('Error updating policy group:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/policy-groups/[id] - 删除分组
export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    // 验证分组存在且用户有权限
    let group = await db.query.policyGroups.findFirst({
      where: and(
        eq(policyGroups.id, id),
        eq(policyGroups.userId, session.user.id)
      ),
    });

    // 如果不是用户的分组,检查团队权限
    if (!group) {
      const adminTeams = await db.query.teamMembers.findMany({
        where: and(
          eq(teamMembers.userId, session.user.id),
          sql`${teamMembers.role} IN ('owner', 'admin')`
        ),
        columns: { teamId: true },
      });

      if (adminTeams.length > 0) {
        const adminTeamIds = adminTeams.map(t => t.teamId);
        group = await db.query.policyGroups.findFirst({
          where: and(
            eq(policyGroups.id, id),
            inArray(policyGroups.teamId, adminTeamIds)
          ),
        });
      }
    }

    if (!group) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 });
    }

    // 系统分组不允许删除
    if (group.isSystem) {
      return NextResponse.json({ error: 'Cannot delete system group' }, { status: 403 });
    }

    // ★安全审计修复（2026-08-17）：级联改写必须带归属谓词。
    //
    // 此前下方事务内的两处 UPDATE 只按 groupId / parentId 过滤、**无 owner 谓词**，
    // 因此删除一个分组会连带改写**他人**归档在其中的策略与子分组。
    // PolicyGroup.parentId 与 Policy.groupId 都是裸 text 列、无外键约束，DB 不会兜底。
    //
    // 这个洞早已被同仓 policy-groups/reorder/route.ts:20-27 的注释准确点名
    // （「DELETE [id] 的级联按 parentId 改写且**无 owner 谓词**」），
    // 但当时只堵了 reorder 侧的 parentId 注入入口，级联本身一直未修。
    //
    // 计数与 UPDATE 必须使用**同一套**谓词，否则会出现「计数为 0 故跳过 UPDATE」
    // 或「计数 > 0 但 UPDATE 影响 0 行」的不一致。
    // 归属口径与 GET 一致：取「我拥有的 OR 我所在团队的」并集。
    // **不可**假设「团队分组内策略必有相同 teamId」——赋值路径只写 groupId，
    // 个人策略（teamId=null）合法地存在于团队分组中。
    const cascadePolicyScope = group.teamId
      ? or(eq(policies.userId, session.user.id), eq(policies.teamId, group.teamId))
      : eq(policies.userId, session.user.id);
    const cascadeChildScope = group.teamId
      ? or(eq(policyGroups.userId, session.user.id), eq(policyGroups.teamId, group.teamId))
      : eq(policyGroups.userId, session.user.id);

    // 注：此前这里有两条 count 查询，仅用作下方 UPDATE 的前置条件。
    // 由于计数谓词与 UPDATE 谓词不一致（前者带 deletedAt IS NULL）会产生
    // 「跳过应做的迁移」或「误改软删行」两种错误，现已改为无条件执行带归属
    // 谓词的幂等 UPDATE，计数不再需要，一并移除以免留下会漂移的第二份谓词。

    // 解析请求体，获取删除选项
    let movePoliciesToParent = true;
    let moveChildrenToParent = true;
    try {
      const body = await req.json();
      movePoliciesToParent = body?.movePoliciesToParent ?? true;
      moveChildrenToParent = body?.moveChildrenToParent ?? true;
    } catch {
      // 无请求体，使用默认值
    }

    // 使用事务处理删除
    await db.transaction(async (tx) => {
      // 处理策略：移动到父分组或取消分组
      //
      // ★不再用 policyCount.count > 0 作为前置条件：该计数带
      //   `deletedAt IS NULL`，而 UPDATE 不带，两者谓词不一致会产生两种错误——
      //     - 组内只有软删策略：count=0 → 跳过 UPDATE → 软删策略留下悬挂 groupId；
      //     - 组内软删与活跃并存：count>0 → UPDATE 连软删策略一并改写。
      //   无条件执行带归属谓词的 UPDATE 本身即幂等（无匹配行则影响 0 行），
      //   不需要计数做门。软删策略同样需要迁移 groupId，否则分组删除后成为悬挂引用。
      // ★两段式：**重定位**受归属限制，**解引用**不受限制。
      //
      //   分组行马上就要被删除，任何仍指向它的 groupId 都会变成悬挂引用。
      //   但「把他人的策略搬到我指定的父分组」是跨租户写（本次修复的对象），
      //   而「把他人策略的 groupId 清空」只是维护引用完整性，不构成越权投放。
      //
      //   数据模型允许成员把个人策略（teamId=null）放进团队分组
      //   （[id]/policies/route.ts 的赋值只写 groupId、不写 teamId），
      //   因此若只做带归属谓词的一段式 UPDATE，这些行会被漏下、
      //   在分组删除后留下悬挂 groupId。故：
      //     第 1 段：我有权处置的行 → 迁到目标父分组（或清空）
      //     第 2 段：剩余仍指向本组的行 → 一律清空（仅解引用，不投放）
      if (movePoliciesToParent && group.parentId) {
        await tx
          .update(policies)
          .set({ groupId: group.parentId })
          .where(and(
            eq(policies.groupId, id),
            cascadePolicyScope
          ));
      }
      // 解引用兜底：无论归属，凡仍指向本组的一律清空，杜绝悬挂引用。
      await tx
        .update(policies)
        .set({ groupId: null })
        .where(eq(policies.groupId, id));

      // 处理子分组：同样的两段式
      if (moveChildrenToParent && group.parentId) {
        await tx
          .update(policyGroups)
          .set({ parentId: group.parentId })
          .where(and(
            eq(policyGroups.parentId, id),
            cascadeChildScope
          ));
      }
      await tx
        .update(policyGroups)
        .set({ parentId: null })
        .where(eq(policyGroups.parentId, id));

      // 删除分组
      await tx.delete(policyGroups).where(eq(policyGroups.id, id));
    });

    return NextResponse.json({
      success: true,
      message: 'Group deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting policy group:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// 辅助函数：检查 targetId 是否是 sourceId 的子孙节点
async function checkIsDescendant(sourceId: string, targetId: string): Promise<boolean> {
  const children = await db.query.policyGroups.findMany({
    where: eq(policyGroups.parentId, sourceId),
    columns: { id: true },
  });

  for (const child of children) {
    if (child.id === targetId) {
      return true;
    }
    const isDescendant = await checkIsDescendant(child.id, targetId);
    if (isDescendant) {
      return true;
    }
  }

  return false;
}
