/*
 * 导出为 Cedar（ADR 0047 §6）。
 * POST /api/policies/[id]/export/cedar
 *
 * 导出 secure-execute 会执行的版本（isDefault 的批准版本，否则最新批准版本）：把未经批准的草稿交给
 * 执行端等于绕过审批，故没有可执行版本时返回 409。cloud 的版本不在 aster-api，故走源码模式：
 * 该版本源码、冻结别名集、与执行同一判定的语言与领域词汇（已审批版本取冻结快照，ADR 0051），
 * 并附 claimedRef（cloud 策略 id 与所导出的版本号，api 只记审计不核验）。仅策略所有者可导出。
 */
import { NextResponse } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { getSession } from '@/lib/auth';
import { db, policies } from '@/lib/prisma';
import { checkRateLimit, getRateLimitHeaders, RateLimitPresets } from '@/lib/rate-limit';
import { policyTenantId } from '@/lib/policy-tenant';
import { createPolicyApiClientForUser } from '@/lib/policy-api-identity';
import { loadStoredVersionCompileContext } from '@/lib/execution-input';
import { PolicyApiError } from '@/services/policy/policy-api';
import { findDefaultExecutableVersion } from '@/services/security/secure-executor';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// 与 aster-api claimedRef 校验一致；不合规时宁可不带，也不让整次导出 400
const CLAIMED_REF_VALUE = /^[A-Za-z0-9._:/-]{1,128}$/;

function claimedRefFor(id: string, version: number): { claimedRef?: Record<string, string> } {
  const ref = { cloudPolicyId: id, version: String(version) };
  return Object.values(ref).every((v) => CLAIMED_REF_VALUE.test(v)) ? { claimedRef: ref } : {};
}

// 版本冻结的别名集（canonical JSON）；与 secure-execute 同一口径，解析失败视同无别名
function parseAliasSet(aliasSet: string | null): Record<string, string[]> | null {
  if (!aliasSet) return null;
  try {
    return JSON.parse(aliasSet) as Record<string, string[]>;
  } catch {
    return null;
  }
}

// 上游忙（503 cedar_export_busy）原样透传给面板以便提示重试；其余上游错误（含 401/403 身份配置问题）一律 502
function upstreamError(error: unknown, headers: Headers): NextResponse {
  const busy = error instanceof PolicyApiError && error.statusCode === 503 && error.code === 'cedar_export_busy';
  if (busy) {
    if (error.retryAfter) headers.set('Retry-After', error.retryAfter);
    return NextResponse.json(error.details ?? { error: error.code, message: error.message }, { status: 503, headers });
  }
  console.error('[api/policies/export/cedar] upstream error', error);
  const message = error instanceof Error ? error.message : 'Failed to export policy';
  return NextResponse.json({ success: false, error: message }, { status: 502, headers });
}

export async function POST(_req: Request, { params }: RouteParams) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  const limit = checkRateLimit(`policy-cedar-export:${userId}`, RateLimitPresets.EVALUATE_SOURCE);
  const headers = new Headers(getRateLimitHeaders(limit, RateLimitPresets.EVALUATE_SOURCE));
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded', retryAfter: limit.retryAfterSeconds }, { status: 429, headers });
  }

  const { id } = await params;
  const policy = await db.query.policies.findFirst({
    where: and(eq(policies.id, id), eq(policies.userId, userId), isNull(policies.deletedAt)),
    columns: { id: true, userId: true, teamId: true },
  });
  // 404 而非 403：不泄露「该 id 存在但不属于你」
  if (!policy) return NextResponse.json({ error: 'Policy not found' }, { status: 404, headers });

  const version = await findDefaultExecutableVersion(policy.id);
  if (!version) return NextResponse.json({ error: 'no executable version' }, { status: 409, headers });
  const source = version.source ?? version.content;

  try {
    const { locale, vocabulary } = await loadStoredVersionCompileContext({ ...version, source });
    const client = await createPolicyApiClientForUser(policyTenantId(policy), userId);
    const result = await client.exportCedar({
      source,
      locale,
      aliasSet: parseAliasSet(version.aliasSet),
      ...(vocabulary ? { vocabulary } : {}),
      ...claimedRefFor(policy.id, version.version),
    });
    return NextResponse.json(result, { headers });
  } catch (error) {
    return upstreamError(error, headers);
  }
}
