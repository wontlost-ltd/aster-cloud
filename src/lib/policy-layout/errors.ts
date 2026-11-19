/**
 * layout 保存错误（ADR 0058 §7.5）与路由响应转换。
 *
 * 五个校验码原样来自 `@aster-cloud/aster-lang-ts/layout`（400），另加能力门禁的
 * `structured_authoring_required`（403）。响应体为 `{ error, code, offset?, limit? }`。
 */
import { NextResponse } from 'next/server';
import type { LayoutErrorCode, LayoutLimitName } from '@aster-cloud/aster-lang-ts/layout';

export type LayoutSaveErrorCode = LayoutErrorCode | 'structured_authoring_required';

export interface LayoutSaveErrorDetail {
  offset?: number;
  limit?: LayoutLimitName;
}

export class LayoutSaveError extends Error {
  constructor(
    readonly code: LayoutSaveErrorCode,
    readonly status: 400 | 403,
    message: string,
    readonly detail: LayoutSaveErrorDetail = {},
  ) {
    super(message);
    this.name = 'LayoutSaveError';
  }
}

/** 非 LayoutSaveError 返回 null，交给调用方的其余错误分支。 */
export function layoutSaveErrorResponse(e: unknown): NextResponse | null {
  if (!(e instanceof LayoutSaveError)) return null;
  return NextResponse.json({ error: e.message, code: e.code, ...e.detail }, { status: e.status });
}
