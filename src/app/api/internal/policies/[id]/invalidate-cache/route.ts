/**
 * 内部端点：失效一个策略的执行缓存（Workers KV）。
 *
 * 执行入口命中 KV 缓存时不查库，版本被改写或归档后必须删除缓存条目，否则旧内容最长再执行 1 小时。
 * Worker 内的写路径直接调 invalidatePolicyCache；跑在 k8s 里的 resolver 迁移 Job 拿不到 KV，
 * 经本端点让 Worker 代为删除（#649）。删除是幂等的，不返回任何策略数据。
 *
 * 安全：与其它 /api/internal/* 相同，fail-closed HMAC 验签（verifyInternalSignature，v2 绑定路径与 nonce），
 * 为某个策略签的请求不能用于另一个策略。
 */

import { NextResponse } from 'next/server';

import { verifyInternalSignature } from '@/lib/internal-signature';
import { invalidatePolicyCache } from '@/lib/cache';

export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const sharedKey = process.env.ASTER_PLAN_GATE_HMAC_KEY;
  if (!sharedKey) {
    return NextResponse.json({ error: 'Internal verification unavailable' }, { status: 503 });
  }
  const rawBody = await req.text();
  const verified = await verifyInternalSignature(req, rawBody, sharedKey);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.reason }, { status: 401 });
  }

  const policyId = (await params).id;
  await invalidatePolicyCache(policyId);
  return NextResponse.json({ invalidated: true });
}
