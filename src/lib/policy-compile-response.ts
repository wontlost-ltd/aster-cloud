import { NextResponse } from 'next/server';
import type { PolicyCompileError } from '@/services/policy/version-manager';

/** 别名校验失败的稳定错误码（保存入口共用，前端按此码本地化）。 */
export const ALIAS_INVALID_CODE = 'alias_invalid';

/**
 * 别名校验失败的消息标记：cloud createVersion 与 aster-api UserAliasValidator 抛出的诊断都以此开头，
 * 'aliasSet 非空' 为 createVersion 缺占用集时的前置失败。
 */
const ALIAS_VALIDATION_MARKERS = ['用户自定义别名校验失败', 'aliasSet 非空'];

/** 消息是否属于别名校验失败。 */
export function isAliasValidationFailure(message: string | undefined | null): boolean {
  return typeof message === 'string' && ALIAS_VALIDATION_MARKERS.some((m) => message.includes(m));
}

/**
 * 保存入口 catch 分支共用：别名校验失败 → 400 alias_invalid（用户可修正的输入错误），
 * 其它错误返回 null 交给调用方继续处理。message 保留诊断原文供 API 调用方排查，UI 只看 code。
 */
export function aliasInvalidResponse(error: unknown): NextResponse | null {
  if (!(error instanceof Error) || !isAliasValidationFailure(error.message)) return null;
  return NextResponse.json(
    { error: 'Invalid aliasSet', code: ALIAS_INVALID_CODE, message: error.message },
    { status: 400 },
  );
}

/**
 * 把保存前编译门禁的拒绝映射为 HTTP 响应，供所有保存入口共用。
 * - 带 retryAfterSeconds（编译检查暂不可用，如上游限流）→ 503 compile_unavailable + Retry-After。
 * - 其余（源码有阻断诊断或上游判定输入非法）→ 400 compile_error。
 *
 * 只按字段判别而不 instanceof 子类：路由测试会整体 mock version-manager。
 */
export function compileGateErrorResponse(error: PolicyCompileError): NextResponse {
  const retryAfter = error.retryAfterSeconds;
  const diagnostics = error.diagnostics;
  // 上游编译因别名校验失败而拒绝时给出稳定码 alias_invalid，前端据此本地化并引导到别名面板，
  // 不直接展示上游的中文诊断原文。
  const aliasInvalid = isAliasValidationFailure(error.message)
    || (diagnostics ?? []).some((d) => isAliasValidationFailure(d.message));
  if (retryAfter !== undefined) {
    return NextResponse.json(
      {
        error: 'compile_unavailable',
        code: 'compile_unavailable',
        message: error.message,
      },
      { status: 503, headers: { 'Retry-After': String(retryAfter) } },
    );
  }
  return NextResponse.json(
    {
      error: 'compile_error',
      code: aliasInvalid ? ALIAS_INVALID_CODE : 'compile_error',
      message: error.message,
      diagnostics: diagnostics ?? [],
    },
    { status: 400 },
  );
}
