/**
 * GET /api/v1/domain-vocabularies/version（#608）
 *
 * 返回当前用户词汇的单调版本号；`?teamId=` 返回团队共享词汇的版本指纹（ADR 0017，需团队成员）。编辑器定期轮询它，版本变化即重新拉取词汇。
 *
 * 取代原先基于进程内 EventEmitter 的 SSE 推送：Cloudflare Workers 多 isolate 下
 * 发布方与订阅方几乎不在同一 isolate，推送永远收不到。轮询一次只是一条主键查询，
 * 比维持长连接或引入 Durable Object 都便宜。
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { errorEnvelope } from '@/lib/api/error-envelope';
import {
  VocabularyError,
  getTeamVocabularyVersion,
  getUserVocabularyVersion,
} from '@/lib/domain-vocabulary';
import { resolveVocabularyOwner, teamIdFromRequest } from '@/lib/domain-vocabulary-team';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return errorEnvelope({ status: 401, code: 'unauthorized', message: 'Sign in required' });
    }
    const owner = await resolveVocabularyOwner(session.user.id, teamIdFromRequest(req), 'view');
    const version = owner.type === 'team'
      ? await getTeamVocabularyVersion(owner.teamId)
      : await getUserVocabularyVersion(session.user.id);
    return NextResponse.json({ version }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof VocabularyError) {
      return errorEnvelope({ status: 403, code: error.code, message: error.message });
    }
    console.error('[domain-vocabularies version GET]', error);
    return errorEnvelope({
      status: 500,
      code: 'service_unavailable',
      message: 'Could not load the vocabulary version. Please retry.',
    });
  }
}
