import { NextResponse } from 'next/server';
import type { PolicyCompileError } from '@/services/policy/version-manager';

/**
 * 把保存前编译门禁的拒绝映射为 HTTP 响应，供所有保存入口共用。
 * - 带 retryAfterSeconds（编译检查暂不可用，如上游限流）→ 503 compile_unavailable + Retry-After。
 * - 其余（源码有阻断诊断或上游判定输入非法）→ 400 compile_error。
 *
 * 只按字段判别而不 instanceof 子类：路由测试会整体 mock version-manager。
 */
export function compileGateErrorResponse(error: PolicyCompileError): NextResponse {
  const retryAfter = error.retryAfterSeconds;
  if (retryAfter !== undefined) {
    return NextResponse.json(
      { error: 'compile_unavailable', message: error.message },
      { status: 503, headers: { 'Retry-After': String(retryAfter) } },
    );
  }
  return NextResponse.json(
    { error: 'compile_error', message: error.message },
    { status: 400 },
  );
}
