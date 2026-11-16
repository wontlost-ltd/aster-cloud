/*
 * 能力授权错误（ADR 0058）。错误码与 HTTP 状态集中在一张表，路由不重复写状态码。
 * invalid_capability_setting 只由平台设置路由内联返回，不经 CapabilityError。
 */

import { NextResponse } from 'next/server';

export const CAPABILITY_ERROR_STATUS = {
  invalid_payload: 400,
  unknown_capability: 404,
  subject_not_found: 404,
  grant_not_found: 404,
  not_team_owner: 403,
  team_delegation_disabled: 403,
  delegation_not_supported: 400,
  not_team_member: 400,
  viewer_not_eligible: 400,
  seat_cap_reached: 409,
  seat_cap_below_active: 409,
} as const;

export type CapabilityErrorCode = keyof typeof CAPABILITY_ERROR_STATUS;

export class CapabilityError extends Error {
  constructor(
    readonly code: CapabilityErrorCode,
    readonly status: number = CAPABILITY_ERROR_STATUS[code],
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'CapabilityError';
  }
}

export function capabilityErrorResponse(e: CapabilityError): NextResponse {
  return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
}
