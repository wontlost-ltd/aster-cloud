import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { createPolicyApiClient, PolicyApiError } from '@/services/policy/policy-api';

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

    if (error instanceof PolicyApiError) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
        },
        { status: error.statusCode }
      );
    }

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
