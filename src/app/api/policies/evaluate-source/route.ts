import { NextResponse } from 'next/server';
import {
  hasInternalDetail,
  MISSING_INPUT_FIELD_CODE,
  missingInputFieldBody,
  publicErrorText,
  sanitizeDiagnostics,
} from '@/lib/execution-error';
import { getSession } from '@/lib/auth';
import { createPolicyApiClient, PolicyApiError, PolicyEvaluateResponse } from '@/services/policy/policy-api';
import {
  checkRateLimit,
  getClientIp,
  getRateLimitHeaders,
  RateLimitPresets,
} from '@/lib/rate-limit';
import { executionQuotaRejection, recordExecutionUsage } from '@/lib/execution-quota';

/**
 * POST /api/policies/evaluate-source
 *
 * 直接执行策略源代码，适用于示例策略和即时测试场景。
 *
 * ============================================================
 * SCOPE — read before adding new callers.
 * ============================================================
 *
 * 这个 endpoint 的用户是 **外部开发者**：通过 quickstart docs
 * (`aster-lang-dev/docs/getting-started/quickstart.md`) 在 curl /
 * SDK 里 "POST 一段 source 立刻看结果"，不必先 CREATE 一个 stored
 * policy。AKA-9 加固后由 HMAC + InternalCallerFilter + 登录会话
 * 三重保护，禁止外部 SDK 客户绕过审核流提交源码。这是有意为之的
 * 开发体验 API。
 *
 * Dashboard 编辑流（/policies/new, /policies/[id]/edit）**不要**
 * 调用本 endpoint。Dashboard 的两类操作走完全独立的路径：
 *
 *   - 实时校验 → `validateSyntaxWithSpan()`（@aster-cloud/aster-lang-ts，
 *     纯 client-side，不出浏览器）
 *   - 执行     → `/api/policies/[id]/execute`（按 id 从 DB 读 source）
 *
 * 为什么 dashboard 必须走 by-id execute、即使是"我刚保存的 policy"
 * 也要再从 DB 读一次：
 *   1. MITM 加固——攻击者劫持浏览器会话也无法把 buffer 里的恶意
 *      source 替换掉数据库里的版本。
 *   2. 用户心智契约——dashboard 用户点 Run 期望执行的是"我刚保存
 *      的版本"。把 buffer 直送 evaluate-source 会出现 audit 日志
 *      和 version 历史都解释不了的 ghost behavior。
 *   3. Audit chain——policy_versions + executions 是按 id 串起来
 *      的；buffer 直接执行会让审计链断裂。
 *
 * 如果你正在加 dashboard 的 "Quick test" 按钮，正确做法是：先
 * 调 PUT /api/policies/[id]（写入并自增 version），再调
 * /api/policies/[id]/execute 用刚保存的版本执行。
 */
export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 限流检查：基于用户ID（已认证用户）+ IP 双重标识
    const _ip = getClientIp(req);
    const rateLimitKey = `evaluate-source:${session.user.id}`;
    const result = checkRateLimit(rateLimitKey, RateLimitPresets.EVALUATE_SOURCE);
    const rateLimitHeaders = getRateLimitHeaders(result, RateLimitPresets.EVALUATE_SOURCE);

    if (!result.allowed) {
      return NextResponse.json(
        {
          error: 'Rate limit exceeded',
          retryAfter: result.retryAfterSeconds,
        },
        { status: 429, headers: rateLimitHeaders }
      );
    }

    // 解析请求体
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: rateLimitHeaders });
    }

    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json(
        { error: 'Request body must be a valid object' },
        { status: 400, headers: rateLimitHeaders }
      );
    }

    const { source, context, locale, functionName } = body as {
      source?: string;
      context?: Record<string, unknown> | unknown[];
      locale?: string;
      functionName?: string;
    };

    if (!source || typeof source !== 'string') {
      return NextResponse.json(
        { error: 'Source code is required' },
        { status: 400, headers: rateLimitHeaders }
      );
    }

    if (context === undefined || context === null) {
      return NextResponse.json(
        { error: 'Context is required' },
        { status: 400, headers: rateLimitHeaders }
      );
    }

    // 执行配额：aster-api 对 cloud 会话的 HMAC 调用不做套餐/用量限制（aster-api#411），必须在此拦截。
    // 与界面执行同口径按 UsageRecord(type=execution) 计，Free 每月 1000 次。
    const quotaRejection = await executionQuotaRejection(session.user.id, rateLimitHeaders);
    if (quotaRejection) {
      return quotaRejection;
    }

    // 调用 Policy API 执行源代码
    const client = createPolicyApiClient(session.user.id, session.user.id);
    const response: PolicyEvaluateResponse = await client.evaluateSource(source, context, {
      locale: locale || 'en-US',
      functionName,
    });
    // 引擎已运行即计一次（含执行错误），与界面执行同口径；aster-api 拒绝/不可达抛异常，不计。
    await recordExecutionUsage(session.user.id);

    // Policy API 返回 { result, executionTimeMs, error }
    // 使用类型断言获取实际字段
    const apiResponse = response as unknown as {
      result: unknown;
      executionTimeMs: number;
      error: string | null;
      executedFunction?: string;
      diagnostics?: PolicyEvaluateResponse['diagnostics'];
    };

    // 如果 error 存在则表示失败
    // 预览场景保留作者可据以修改源码的错误（如 CNL 语法错误）；带 Java 异常/内部路径的原文只进日志。
    if (apiResponse.error) {
      if (hasInternalDetail(apiResponse.error)) {
        console.error('[evaluate-source] engine error', { error: apiResponse.error });
      }
      return NextResponse.json(
        {
          success: false,
          error: publicErrorText(apiResponse.error),
          executionTimeMs: apiResponse.executionTimeMs,
          executedFunction: apiResponse.executedFunction,
          diagnostics: sanitizeDiagnostics(apiResponse.diagnostics),
        },
        { status: 400, headers: rateLimitHeaders }
      );
    }

    // Bug-4 修复：识别 result 对象中的决策字段而不是用 Boolean(整对象) → 总 truthy
    // 同 cnl-executor.parseAsterCNLResult 的 approvalFields 顺序，保持语义一致
    function deriveApproved(r: unknown): boolean {
      if (r === null || r === undefined) return false;
      if (typeof r === 'boolean') return r;
      if (typeof r === 'object') {
        const obj = r as Record<string, unknown>;
        for (const f of ['approved', 'isApproved', 'allowed', 'isAllowed', 'isEligible', 'eligible', 'isSuccess', 'success', '批准', 'genehmigt']) {
          if (f in obj) return obj[f] === true || obj[f] === 'true';
        }
        // 未识别决策字段 → 视为有结果即成功（与 cnl-executor _type 分支语义一致）
        return true;
      }
      return Boolean(r);
    }

    return NextResponse.json(
      {
        executionId: `exec-${Date.now()}`,
        success: true,
        output: {
          matchedRules: [],
          actions: [],
          approved: deriveApproved(apiResponse.result),
        },
        result: apiResponse.result,
        durationMs: apiResponse.executionTimeMs || 0,
        executedFunction: apiResponse.executedFunction,
        diagnostics: sanitizeDiagnostics(apiResponse.diagnostics),
      },
      { headers: rateLimitHeaders }
    );
  } catch (error) {
    // 输入缺少规则读取的字段（aster-api 400）：输入错误，按码 + 字段路径返回，不当作执行故障记日志
    const missingField = error instanceof PolicyApiError && error.code === MISSING_INPUT_FIELD_CODE
      ? error.details?.field : undefined;
    if (typeof missingField === 'string' && missingField !== '') {
      return NextResponse.json({ success: false, ...missingInputFieldBody(missingField) }, { status: 400 });
    }
    console.error('Error evaluating policy source:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? publicErrorText(error.message) : 'Internal server error',
        diagnostics: error instanceof PolicyApiError ? sanitizeDiagnostics(error.diagnostics) : undefined,
      },
      { status: error instanceof PolicyApiError ? error.statusCode : 500 }
    );
  }
}
