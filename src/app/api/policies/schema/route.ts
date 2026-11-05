import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { createPolicyApiClient, PolicyApiError } from '@/services/policy/policy-api';

/**
 * 上游拒绝了这次请求：4xx（不含 401/403 身份配置问题与 408 客户端超时）。
 */
function isUpstreamRejection(e: PolicyApiError): boolean {
  const s = e.statusCode;
  return s >= 400 && s < 500 && s !== 401 && s !== 403 && s !== 408;
}

/**
 * 上游错误 → 稳定 code + 英文文案（#711）：原文可能是中文、内部类名或主机 / IP / 端口，只写服务端日志。
 * 业务拒绝保留状态码；其余（5xx、超时、网络、身份配置）统一 502 并附 requestId。
 */
function upstreamErrorResponse(e: PolicyApiError): NextResponse {
  if (isUpstreamRejection(e)) {
    return NextResponse.json(
      {
        success: false,
        error: 'schema_request_rejected',
        code: 'schema_request_rejected',
        message: 'The policy schema could not be extracted from this source.',
      },
      { status: e.statusCode }
    );
  }
  const requestId = crypto.randomUUID();
  console.error(`[api/policies/schema] upstream error requestId=${requestId}`, e.statusCode, e.code, e.message);
  return NextResponse.json(
    {
      success: false,
      error: 'upstream_unavailable',
      code: 'upstream_unavailable',
      message: 'The policy engine could not be reached. Please try again later.',
      requestId,
    },
    { status: 502, headers: { 'x-request-id': requestId } }
  );
}

/**
 * POST /api/policies/schema
 *
 * 获取策略参数模式，用于动态表单生成
 * 调用远程 Policy API 进行解析，避免在 Worker 中加载重型编译器
 */
export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 解析请求体
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Request body must be a valid object' }, { status: 400 });
    }

    const { source, functionName, locale } = body as {
      source?: string;
      functionName?: string;
      locale?: string;
    };

    if (!source || typeof source !== 'string') {
      return NextResponse.json({ error: 'Source code is required' }, { status: 400 });
    }

    // 使用远程 Policy API 提取 schema
    const apiClient = createPolicyApiClient('default', session.user.id);
    const result = await apiClient.getSchema(source, {
      functionName,
      locale: locale || 'en-US',
    });

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          error: result.error || 'Failed to parse CNL source',
        },
        { status: 400 }
      );
    }

    // 返回 schema 响应（扁平化结构以匹配前端 PolicySchema 接口）
    return NextResponse.json({
      success: true,
      functionName: result.functionName,
      parameters: result.parameters,
      moduleName: result.moduleName,
    });
  } catch (error) {
    console.error('Error getting policy schema:', error);

    if (error instanceof PolicyApiError) return upstreamErrorResponse(error);

    // 未识别的异常只写日志（上方 console.error），不回传原始消息（#662）。
    return NextResponse.json(
      {
        success: false,
        error: 'Internal server error',
        code: 'internal_error',
      },
      { status: 500 }
    );
  }
}
