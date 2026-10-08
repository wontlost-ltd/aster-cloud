import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { db, policies } from '@/lib/prisma';
import { eq, and, isNull } from 'drizzle-orm';
import { queryExecutionLogs, getExecutionStats, getRecentExecutions } from '@/lib/policy-execution-log';
import type { ExecutionSource } from '@/lib/prisma';
import { executionDecisionEnum } from '@/db/schema';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/policies/[id]/logs - Get execution logs for a policy
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const { searchParams } = new URL(req.url);

    // 验证策略归属
    const policy = await db.query.policies.findFirst({
      where: and(
        eq(policies.id, id),
        eq(policies.userId, session.user.id),
        isNull(policies.deletedAt)
      ),
      columns: { id: true, name: true },
    });

    if (!policy) {
      return NextResponse.json({ error: 'Policy not found' }, { status: 404 });
    }

    // 解析查询参数
    const page = parseInt(searchParams.get('page') || '1', 10);
    const pageSize = Math.min(parseInt(searchParams.get('pageSize') || '20', 10), 100);
    const success = searchParams.get('success');
    // 按准入决策过滤（可选）：取值以 executionDecisionEnum 为准（含 require_approval/escalate）。非法值忽略。
    const decisionParam = searchParams.get('decision');
    const decision = (executionDecisionEnum.enumValues as readonly string[]).includes(decisionParam ?? '')
      ? (decisionParam as (typeof executionDecisionEnum.enumValues)[number])
      : undefined;
    const source = searchParams.get('source') as ExecutionSource | null;
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');
    const mode = searchParams.get('mode'); // 'recent' | 'stats' | undefined

    // 根据模式返回不同数据
    if (mode === 'recent') {
      const limit = parseInt(searchParams.get('limit') || '10', 10);
      const items = await getRecentExecutions(id, session.user.id, limit);
      return NextResponse.json({ items, policy: { id: policy.id, name: policy.name } });
    }

    if (mode === 'stats') {
      const days = parseInt(searchParams.get('days') || '30', 10);
      const stats = await getExecutionStats(session.user.id, id, days);
      return NextResponse.json({ stats, policy: { id: policy.id, name: policy.name } });
    }

    // 默认：分页查询
    const result = await queryExecutionLogs({
      userId: session.user.id,
      policyId: id,
      success: success ? success === 'true' : undefined,
      decision,
      source: source || undefined,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      page,
      pageSize,
    });

    return NextResponse.json({
      ...result,
      policy: { id: policy.id, name: policy.name },
    });
  } catch (error) {
    console.error('Error fetching execution logs:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
