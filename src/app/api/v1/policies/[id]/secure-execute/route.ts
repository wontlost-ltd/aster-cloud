/**
 * 安全执行 API 端点
 *
 * 实现基于签名验证的策略执行：
 * - 验证 HMAC-SHA256 签名
 * - 验证时间戳有效性
 * - 验证 Nonce 防重放
 * - 验证哈希匹配
 * - 执行策略（使用数据库源码）
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';

import { executeSecurely } from '@/services/security/secure-executor';
import { AMBIGUOUS_INPUT_FIELD_CODE } from '@/lib/execution-input';
import { PolicyAccessDeniedError } from '@/services/policy/version-manager';
import type { SignedRequest } from '@/services/security/policy-security';
import { v4 as uuidv4 } from 'uuid';

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

    // 5. 安全执行
    const result = await executeSecurely({
      request: signedRequest,
      userId: session.user.id,
      tenantId: (session.user as { teamId?: string }).teamId || session.user.id,
      ipAddress,
      userAgent,
      requestId,
    });

    // 6. 返回结果
    const status = result.success
      ? 200
      : result.errorCode === 'SIGNATURE_INVALID'
        ? 401
        : result.errorCode === 'HASH_MISMATCH'
          ? 409
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
        requestId,
      },
      { status }
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
