import { NextResponse } from 'next/server';

/** 当前 api 尚无按版本查询的公开校验端点，未知状态不推断为有效或无效。 */
export async function GET() {
  return NextResponse.json({ status: 'unknown' });
}
