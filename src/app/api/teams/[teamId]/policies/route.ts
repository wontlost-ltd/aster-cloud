import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { db, policies, executions } from '@/lib/prisma';
import { eq, desc, sql } from 'drizzle-orm';
import { checkTeamPermission, TeamPermission } from '@/lib/team-permissions';
import { assertCompilable, PolicyCompileError } from '@/services/policy/version-manager';
import { makeCompileValidator } from '@/lib/policy-compile-validator';


type RouteParams = { params: Promise<{ teamId: string }> };

// GET /api/teams/[teamId]/policies - 列出团队策略
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    const { teamId } = await params;

    // 检查查看策略的权限
    const permission = await checkTeamPermission(
      session.user.id,
      teamId,
      TeamPermission.POLICY_VIEW
    );
    if (!permission.allowed) {
      return NextResponse.json({ error: permission.error }, { status: permission.status });
    }

    const teamPolicies = await db.query.policies.findMany({
      where: eq(policies.teamId, teamId),
      with: {
        user: {
          columns: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: desc(policies.updatedAt),
    });

    // 并行获取每个策略的执行次数
    const policiesWithCounts = await Promise.all(
      teamPolicies.map(async (policy) => {
        const [executionCountResult] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(executions)
          .where(eq(executions.policyId, policy.id));

        return {
          id: policy.id,
          name: policy.name,
          description: policy.description,
          version: policy.version,
          piiFields: policy.piiFields,
          createdBy: policy.user
            ? {
                id: policy.user.id,
                name: policy.user.name,
              }
            : null,
          executionCount: executionCountResult.count,
          createdAt: policy.createdAt.toISOString(),
          updatedAt: policy.updatedAt.toISOString(),
        };
      })
    );

    return NextResponse.json({
      policies: policiesWithCounts,
    });
  } catch (error) {
    console.error('Error listing team policies:', error);
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 });
  }
}

// POST /api/teams/[teamId]/policies - 分配策略到团队或创建新策略
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    const { teamId } = await params;

    // 检查创建策略的权限
    const permission = await checkTeamPermission(
      session.user.id,
      teamId,
      TeamPermission.POLICY_CREATE
    );
    if (!permission.allowed) {
      return NextResponse.json({ error: permission.error }, { status: permission.status });
    }

    const { policyId, name, content, description } = await req.json();

    // 如果提供了 policyId，将现有策略分配给团队
    if (policyId) {
      // 获取策略信息
      const existingPolicy = await db.query.policies.findFirst({
        where: eq(policies.id, policyId),
      });

      if (!existingPolicy || existingPolicy.teamId !== null) {
        return NextResponse.json(
          { error: '策略不存在或已分配给其他团队' },
          { status: 404 }
        );
      }

      // 安全检查：只允许策略所有者本人导入自己的策略到团队
      // 防止未经授权泄露他人策略内容
      if (existingPolicy.userId !== session.user.id) {
        return NextResponse.json({ error: '只能导入自己的策略' }, { status: 403 });
      }

      // 分配策略到团队
      const [updatedPolicy] = await db
        .update(policies)
        .set({ teamId })
        .where(eq(policies.id, policyId))
        .returning();

      if (!updatedPolicy) {
        throw new Error('Failed to update policy');
      }

      return NextResponse.json({
        id: updatedPolicy.id,
        name: updatedPolicy.name,
        teamId: updatedPolicy.teamId,
      });
    }

    // 否则，创建新的团队策略
    if (!name || typeof name !== 'string' || name.length < 1) {
      return NextResponse.json({ error: '策略名称不能为空' }, { status: 400 });
    }

    if (!content || typeof content !== 'string') {
      return NextResponse.json({ error: '策略内容不能为空' }, { status: 400 });
    }

    // ★编译门禁：与 /api/policies 和 /api/v1/.../versions 保持一致。
    //   此入口此前无门禁——不可解析的源码能落库，直到**执行时**才报语法错。
    //   实测事故：AI 生成的 `is < 18`（is 后接符号）由此入口存入，
    //   用户在执行页才看到「行 15 第 25 列」的报错。
    //   放在插入**之前**（事务外）：避免事务内网络调用持锁。
    await assertCompilable(makeCompileValidator(session.user.id), {
      source: content,
      locale: 'en-US',
      aliasSet: null,
    });

    const newPolicyId = globalThis.crypto.randomUUID();
    const [newPolicy] = await db
      .insert(policies)
      .values({
        id: newPolicyId,
        name,
        content,
        description: description || null,
        userId: session.user.id,
        teamId,
      })
      .returning();

    if (!newPolicy) {
      throw new Error('Failed to create policy');
    }

    return NextResponse.json(
      {
        id: newPolicy.id,
        name: newPolicy.name,
        description: newPolicy.description,
        teamId: newPolicy.teamId,
        createdAt: newPolicy.createdAt.toISOString(),
      },
      { status: 201 }
    );
  } catch (error: unknown) {
    // 有解析错误的源码——用户可修正的 4xx，不是 500。
    if (error instanceof PolicyCompileError) {
      return NextResponse.json(
        { error: 'compile_error', message: error.message },
        { status: 400 }
      );
    }
    console.error('Error creating team policy:', error);
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 });
  }
}
