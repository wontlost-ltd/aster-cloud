import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { executionAggregateScope, executionDetailScope, loadPolicyForAction, policyAccessDeniedResponse } from '@/lib/policy-access';
import { queryExecutionLogs, getExecutionStats, getRecentExecutions } from '@/lib/policy-execution-log';
import { executionDecisionEnum, executionSourceEnum } from '@/db/schema';
import { parseDateParam, parseEnumParam, parsePositiveInt } from '@/lib/api/query-params';

/** 单页 / 最近执行条数上限。 */
const MAX_PAGE_SIZE = 100;
/** 统计回溯天数上限：再长的区间对单个策略的统计没有意义，只会拖慢查询。 */
const MAX_STATS_DAYS = 365;

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

    // 团队策略按当前成员角色（任一角色可看），个人策略只认所有者（#669 #670）
    const access = await loadPolicyForAction(id, { userId: session.user.id }, 'view');
    if (!access.ok) return policyAccessDeniedResponse(access.decision);
    const policy = access.policy;
    // 明细只含团队现任成员的执行（团队外经公开 / 分享留下的原始记录属于执行人），统计计入全部执行；
    // 个人策略只看所有者本人的执行（#673，ADR 0016 §3）
    const detail = executionDetailScope(policy);

    // 解析查询参数：非法值回落默认值或忽略该过滤条件，不把 NaN / Invalid Date / 非法枚举交给查询层
    const page = parsePositiveInt(searchParams.get('page'), 1);
    const pageSize = parsePositiveInt(searchParams.get('pageSize'), 20, MAX_PAGE_SIZE);
    const legacySuccess = searchParams.get('success');
    // 按准入决策过滤（可选）：取值以 executionDecisionEnum 为准（含 require_approval/escalate）。
    const requestedDecision = searchParams.get('decision');
    const decision = requestedDecision === 'success' ? 'approved'
      : requestedDecision === 'failed' ? undefined
        : parseEnumParam(requestedDecision, executionDecisionEnum.enumValues);
    const source = parseEnumParam(searchParams.get('source'), executionSourceEnum.enumValues);
    const startDate = parseDateParam(searchParams.get('startDate'));
    const endDate = parseDateParam(searchParams.get('endDate'));
    const mode = searchParams.get('mode'); // 'recent' | 'stats' | undefined

    // 根据模式返回不同数据
    if (mode === 'recent') {
      const limit = parsePositiveInt(searchParams.get('limit'), 10, MAX_PAGE_SIZE);
      const items = await getRecentExecutions(id, detail, limit);
      return NextResponse.json({ items, policy: { id: policy.id, name: policy.name } });
    }

    if (mode === 'stats') {
      const days = parsePositiveInt(searchParams.get('days'), 30, MAX_STATS_DAYS);
      const stats = await getExecutionStats(executionAggregateScope(policy), id, days);
      return NextResponse.json({ stats, policy: { id: policy.id, name: policy.name } });
    }

    // 默认：分页查询
    const result = await queryExecutionLogs({
      executors: detail,
      policyId: id,
      legacyFailed: requestedDecision === 'failed' || legacySuccess === 'false',
      legacyError: requestedDecision === 'error',
      legacyApproved: requestedDecision === 'success' || legacySuccess === 'true',
      decision,
      source,
      startDate,
      endDate,
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
