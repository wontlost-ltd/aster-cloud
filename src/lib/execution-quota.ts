/**
 * 会话执行的月度执行配额（UsageRecord type=execution，Free 每月 1000 次）。
 *
 * cloud 代登录会话经 plan-gate HMAC 调 aster-api 执行策略时，aster-api 不做任何套餐或用量限制
 * （aster-api#411：它的 API 月度配额只管 API key 调用），所以每一个这样调用 aster-api 的 cloud 会话
 * 路由都必须在调用前用本模块拦截、在引擎运行后计量。新增此类路由时同样要接入。
 *
 * 界面执行（/api/policies/[id]/execute）与 cloud REST 执行（/api/v1/policies/[id]/execute）沿用各自
 * 合并查询里的同口径判定，不经本模块。
 */
import { NextResponse } from 'next/server';
import { checkUsageLimit, recordUsage } from '@/lib/usage';
import { upgradeResponse } from '@/lib/plan-quota';

/**
 * 调用方本月执行数已达上限时返回 429（与界面执行相同的 upgradeResponse('evaluations') 响应体），否则 null。
 * 用户记录不存在时按未认证处理（401）。
 */
export async function executionQuotaRejection(
  userId: string,
  headers?: HeadersInit
): Promise<NextResponse | null> {
  const check = await checkUsageLimit(userId, 'execution');
  if (check.allowed) {
    return null;
  }
  if (check.limit === undefined) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers });
  }
  return NextResponse.json(
    upgradeResponse('evaluations', {
      usage: check.used ?? check.limit,
      limit: check.limit,
      message: `You've reached your monthly limit of ${check.limit} executions.`,
    }),
    { status: 429, headers }
  );
}

/** 引擎已运行（无论策略结果或执行错误）后计一次执行；写失败只记日志，不影响响应。 */
export async function recordExecutionUsage(userId: string): Promise<void> {
  try {
    await recordUsage(userId, 'execution');
  } catch (err) {
    console.error('[execution-quota] failed to record execution usage', err);
  }
}
