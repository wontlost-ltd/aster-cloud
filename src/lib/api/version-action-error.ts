import { NextResponse } from 'next/server';
import type { ErrorEnvelopeBody } from '@/lib/api/error-envelope';
import { VersionStateError } from '@/services/policy/version-state-error';

/**
 * 路由兜底：未识别的异常只进服务端日志（以 requestId 关联），响应只给通用文案 + internal_error + requestId。
 * 原始 error.message 可能带数据库错误、表名或内部路径，绝不回传客户端。
 */
export function internalErrorResponse(logTag: string, error: unknown, message: string): NextResponse {
  const requestId = crypto.randomUUID();
  console.error(`[${logTag}] requestId=${requestId}`, error);
  // 结构化 envelope 之外再给顶层 message（与 envelope 内相同）：只读顶层 message 的前端也能拿到可读字符串
  const body: ErrorEnvelopeBody & { message: string } = {
    error: { code: 'internal_error', message, requestId },
    message,
  };
  return NextResponse.json(body, { status: 500, headers: { 'x-request-id': requestId } });
}

/**
 * 版本操作路由的 catch 兜底：版本状态错误（不存在、状态不符、默认版本）原样返回 400 与稳定 code；
 * 其余按内部错误处理。各路由自己的已知错误（归属、四眼原则等）应在调用本函数前处理。
 */
export function versionActionErrorResponse(logTag: string, error: unknown, fallbackMessage: string): NextResponse {
  if (error instanceof VersionStateError) {
    return NextResponse.json(
      { error: error.message, code: error.code, message: error.message },
      { status: 400 },
    );
  }
  return internalErrorResponse(logTag, error, fallbackMessage);
}
