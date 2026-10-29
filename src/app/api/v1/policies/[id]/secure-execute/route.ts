/**
 * 安全执行 API 端点
 *
 * 实现基于签名验证的策略执行：
 * - 验证 HMAC-SHA256 签名
 * - 验证时间戳有效性
 * - 验证 Nonce 防重放
 * - 验证哈希匹配
 * - 执行策略（使用数据库源码）
 *
 * 套餐与用量：按用户限流（每分钟 30 次），并按执行用量（UsageRecord type=execution）拦截与计量——
 * aster-api 对 cloud 会话的 HMAC 调用不做任何套餐或用量限制（aster-api#411）。
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';

import { executeSecurely } from '@/services/security/secure-executor';
import { AMBIGUOUS_INPUT_FIELD_CODE, ENTRY_RULE_REQUIRED_CODE, INPUT_TYPE_EXTRACTION_FAILED_CODE } from '@/lib/execution-input';
import { PolicyAccessDeniedError } from '@/services/policy/version-manager';
import type { SignedRequest } from '@/services/security/policy-security';
import { v4 as uuidv4 } from 'uuid';
import { checkRateLimitDistributed } from '@/lib/rate-limit-distributed';
import { getRateLimitHeaders, RateLimitPresets } from '@/lib/rate-limit';
import { executionQuotaRejection, recordExecutionUsage } from '@/lib/execution-quota';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const requestId = uuidv4();

  try {
    // 1. 认证
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized', code: 'unauthorized', requestId },
        { status: 401 }
      );
    }

    const userId = session.user.id;

    // 限流：按用户，跨 isolate 共享计数（KV），与策略执行同一预设（每分钟 30 次）
    const rate = await checkRateLimitDistributed(`secure-execute:${userId}`, RateLimitPresets.POLICY_EXECUTE);
    const rateLimitHeaders = getRateLimitHeaders(rate, RateLimitPresets.POLICY_EXECUTE);
    if (!rate.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded', code: 'rate_limited', retryAfter: rate.retryAfterSeconds, requestId },
        { status: 429, headers: rateLimitHeaders }
      );
    }

    const { id } = await params;

    // 2. 解析请求体
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, error: 'Request body must be valid JSON.', code: 'invalid_json', requestId },
        { status: 400 }
      );
    }

    // 3. 验证请求体字段
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { success: false, error: 'Request body must be a valid object.', code: 'invalid_request_body', requestId },
        { status: 400 }
      );
    }

    const {
      hash,
      input,
      timestamp,
      nonce,
      signature,
      version,
    } = body as Record<string, unknown>;

    // 验证必填字段
    if (
      typeof hash !== 'string' ||
      typeof timestamp !== 'number' ||
      typeof nonce !== 'string' ||
      typeof signature !== 'string'
    ) {
      return NextResponse.json(
        {
          success: false,
          error: 'Required fields are missing: hash, timestamp, nonce, and signature.', code: 'required_fields_missing',
          requestId,
        },
        { status: 400 }
      );
    }

    // 验证 input 是对象
    if (input !== undefined && (typeof input !== 'object' || input === null)) {
      return NextResponse.json(
        { success: false, error: 'input must be a valid object.', code: 'invalid_input', requestId },
        { status: 400 }
      );
    }

    // 验证 version 是数字（如果提供）
    if (version !== undefined && typeof version !== 'number') {
      return NextResponse.json(
        { success: false, error: 'version must be a number.', code: 'invalid_version', requestId },
        { status: 400 }
      );
    }

    const signedRequest: SignedRequest = {
      policyId: id,
      hash,
      input: input ?? {},
      timestamp,
      nonce,
      signature,
      version: typeof version === 'number' ? version : undefined,
    };

    // 4. 获取请求元数据
    const ipAddress =
      request.headers.get('x-forwarded-for')?.split(',')[0] ||
      request.headers.get('x-real-ip') ||
      'unknown';
    const userAgent = request.headers.get('user-agent') || undefined;

    // 5. 执行配额：aster-api 对 cloud 会话的 HMAC 调用不做套餐/用量限制（aster-api#411），
    //    与界面执行同口径按 UsageRecord(type=execution) 拦截，Free 每月 1000 次。
    const quotaRejection = await executionQuotaRejection(userId, rateLimitHeaders);
    if (quotaRejection) {
      return quotaRejection;
    }

    // 6. 安全执行
    const result = await executeSecurely({
      request: signedRequest,
      userId,
      tenantId: (session.user as { teamId?: string }).teamId || userId,
      ipAddress,
      userAgent,
      requestId,
    });
    if (result.engineInvoked) {
      await recordExecutionUsage(userId);
    }

    // 7. 返回结果
    const status = result.success
      ? 200
      : result.errorCode === 'SIGNATURE_INVALID'
        ? 401
        : result.errorCode === 'SIGNING_UNAVAILABLE'
          ? 503
          : result.errorCode === 'HASH_MISMATCH'
            ? 409
            : result.errorCode === 'INPUT_TYPE_EXTRACTION_FAILED' || result.errorCode === 'ENTRY_RULE_REQUIRED'
              ? 422
              : 400;

    return NextResponse.json(
      {
        success: result.success,
        result: result.result,
        error: result.error,
        errorCode: result.errorCode,
        executionTimeMs: result.executionTimeMs,
        version: result.version,
        sourceHash: result.sourceHash,
        isDeprecated: result.isDeprecated,
        expectedVersion: result.expectedVersion,
        expectedHash: result.expectedHash,
        // #626（新增可选字段）：输入歧义时给出稳定码与冲突字段路径，与 execute 端点同口径。
        ...(result.ambiguous
          ? {
              code: AMBIGUOUS_INPUT_FIELD_CODE,
              field: result.ambiguous.field,
              fields: result.ambiguous.fields,
              policyField: result.ambiguous.policyName,
            }
          : {}),
        // #638：输入类型提取失败时给出与 execute 端点相同的稳定码。
        ...(result.errorCode === 'INPUT_TYPE_EXTRACTION_FAILED' ? { code: INPUT_TYPE_EXTRACTION_FAILED_CODE } : {}),
        ...(result.errorCode === 'ENTRY_RULE_REQUIRED' ? { code: ENTRY_RULE_REQUIRED_CODE, rules: result.entryRules } : {}),
        requestId,
      },
      { status, headers: rateLimitHeaders }
    );
  } catch (error) {
    // 归属校验失败一律回 404（不是 403）——与兄弟版本路由一致，
    // 刻意不泄露「该 policyId 是否存在」，避免被用来枚举他人策略 ID。
    if (error instanceof PolicyAccessDeniedError) {
      return NextResponse.json(
        { success: false, error: 'Policy not found.', code: 'policy_not_found', requestId },
        { status: 404 }
      );
    }
    console.error(`[SecureExecute] Request ${requestId} failed:`, error);
    return NextResponse.json(
      {
        success: false,
        error: 'Internal server error.', code: 'internal_server_error',
        requestId,
      },
      { status: 500 }
    );
  }
}
