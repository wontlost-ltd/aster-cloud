/*
 * 导出为 Cedar（ADR 0047 §6）。
 * POST /api/policies/[id]/export/cedar
 *
 * 导出执行路径会选中的版本（isDefault 的批准版本，否则最新批准版本）：把未经批准的草稿交给
 * 执行端等于绕过审批，故没有可执行版本时返回 409。cloud 的版本不在 aster-api，故走源码模式：
 * 该版本源码、冻结别名集（与执行一样按已授权应用，含结构词别名）、与执行同一判定的语言与领域词汇（已审批版本取冻结快照，ADR 0051），
 * 并附 claimedRef（cloud 策略 id 与所导出的版本号，api 只记审计不核验）。仅策略所有者可导出。
 *
 * 请求体可选 `{ functionName }`（#661）：可导出的规则不止一条时（E720）由调用方指定导出哪一条。
 * 规则名须属于所导出的版本（源码写法或经版本词汇映射后的规范名，转发时一律用规范名），否则 400，不转发给 aster-api。
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { loadPolicyForAction, policyAccessDeniedResponse } from '@/lib/policy-access';
import { checkRateLimit, getRateLimitHeaders, RateLimitPresets } from '@/lib/rate-limit';
import { policyTenantId } from '@/lib/policy-tenant';
import { createPolicyApiClientForUser } from '@/lib/policy-api-identity';
import { loadStoredVersionCompileContext } from '@/lib/execution-input';
import { versionVocabularyErrorResponse } from '@/lib/policy-compile-response';
import { PolicyApiError } from '@/services/policy/policy-api';
import { findDefaultExecutableVersion } from '@/services/policy/default-executable-version';
import { resolvePolicyRuleName } from '@/lib/cedar-export-rules';
import { registeredUpstreamMessage } from '@/lib/upstream-error-messages';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// 与 aster-api claimedRef 校验一致；不合规时宁可不带，也不让整次导出 400
const CLAIMED_REF_VALUE = /^[A-Za-z0-9._:/-]{1,128}$/;

function claimedRefFor(id: string, version: number): { claimedRef?: Record<string, string> } {
  const ref = { cloudPolicyId: id, version: String(version) };
  return Object.values(ref).every((v) => CLAIMED_REF_VALUE.test(v)) ? { claimedRef: ref } : {};
}

// 版本冻结的别名集（canonical JSON）；与执行路径同一口径，解析失败视同无别名
function parseAliasSet(aliasSet: string | null): Record<string, string[]> | null {
  if (!aliasSet) return null;
  try {
    return JSON.parse(aliasSet) as Record<string, string[]>;
  } catch {
    return null;
  }
}

const EXPORT_FAILED_MESSAGE = 'Cedar export failed. Please try again later.';

/** aster-api CedarExportResource 的稳定 4xx 错误码：只透传这些（#711），文案按 code 换成英文。 */
const CEDAR_REJECTION_CODES: ReadonlySet<string> = new Set(['alias_set_too_large', 'vocabulary_too_large']);

/**
 * 上游拒绝了这次导出（4xx，且 code 已登记）。aster-api 的部分 4xx 把句子放在 code 字段，
 * GlobalExceptionMapper 的 4xx 可能带内部类名，这些都不透传，按通用失败处理（#711）。
 * 401/403 是 cloud 与 api 之间的身份配置问题、408 / UNKNOWN 是客户端包装的超时与网络异常，都不算。
 */
function upstreamRejection(error: unknown): { code: string; message: string } | null {
  if (!(error instanceof PolicyApiError) || !error.code || !CEDAR_REJECTION_CODES.has(error.code)) return null;
  const s = error.statusCode;
  const message = registeredUpstreamMessage(error.code);
  return s >= 400 && s < 500 && s !== 401 && s !== 403 && s !== 408 && message ? { code: error.code, message } : null;
}

/**
 * 上游忙（503 cedar_export_busy）原样透传给面板以便提示重试；上游 4xx 拒绝保留其 code 与面向用户的文案；
 * 其余（5xx、身份配置、网络异常、内部异常）一律 502 通用文案（#688）：原文可能含内部主机名、IP 或端口，
 * 只写服务端日志并以 requestId 关联。
 */
function upstreamError(error: unknown, headers: Headers): NextResponse {
  const busy = error instanceof PolicyApiError && error.statusCode === 503 && error.code === 'cedar_export_busy';
  if (busy) {
    if (error.retryAfter) headers.set('Retry-After', error.retryAfter);
    return NextResponse.json(error.details ?? { error: error.code, message: error.message }, { status: 503, headers });
  }
  const rejected = upstreamRejection(error);
  if (rejected) {
    console.warn('[api/policies/export/cedar] upstream rejected', rejected.code);
    return NextResponse.json(
      { success: false, error: rejected.code, code: rejected.code, message: rejected.message },
      { status: 502, headers },
    );
  }
  const requestId = crypto.randomUUID();
  console.error(`[api/policies/export/cedar] upstream error requestId=${requestId}`, error);
  headers.set('x-request-id', requestId);
  return NextResponse.json(
    { success: false, error: 'cedar_export_failed', code: 'cedar_export_failed', message: EXPORT_FAILED_MESSAGE, requestId },
    { status: 502, headers },
  );
}

/** 可选的请求体 `{ functionName }`：无请求体或不带该键视为未指定；形状不对返回 null。 */
async function readFunctionName(req: Request): Promise<{ functionName?: string } | null> {
  const text = await req.text().catch(() => '');
  if (!text.trim()) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const raw = (body as { functionName?: unknown }).functionName;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return { functionName: raw.trim() };
}

export async function POST(req: Request, { params }: RouteParams) {
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

  const requested = await readFunctionName(req);
  if (!requested) {
    return NextResponse.json({ error: 'invalid_function_name', message: 'functionName must be a non-empty string' }, { status: 400, headers });
  }

  const { id } = await params;
  // 团队策略任一成员可导出（只读），个人策略只认所有者；非成员 404，不泄露「该 id 存在但不属于你」
  const access = await loadPolicyForAction(id, { userId }, 'view');
  if (!access.ok) return policyAccessDeniedResponse(access.decision, { headers });
  const policy = access.policy;

  const version = await findDefaultExecutableVersion(policy.id);
  if (!version) return NextResponse.json({ error: 'no executable version' }, { status: 409, headers });
  const source = version.source ?? version.content;

  try {
    const { locale, vocabulary } = await loadStoredVersionCompileContext({ ...version, source, teamId: policy.teamId ?? null });
    const functionName = requested.functionName && resolvePolicyRuleName(source, vocabulary, requested.functionName);
    if (functionName === null) {
      return NextResponse.json({ error: 'unknown_function', message: 'functionName is not a rule of this policy version' }, { status: 400, headers });
    }
    const client = await createPolicyApiClientForUser(policyTenantId(policy), userId);
    const aliasSet = parseAliasSet(version.aliasSet);
    const result = await client.exportCedar({
      source,
      locale,
      aliasSet,
      // 冻结即信任：与执行路径同一判定，已批准版本的别名集按已授权编译（含结构词别名）。
      // aster-api 仅对 HMAC 已验签的调用方采信该标记；无别名时不带，保持原请求形状。
      ...(aliasSet && Object.keys(aliasSet).length > 0 ? { allowStructural: true } : {}),
      ...(vocabulary ? { vocabulary } : {}),
      ...(functionName ? { functionName } : {}),
      ...claimedRefFor(policy.id, version.version),
    });
    return NextResponse.json(result, { headers });
  } catch (error) {
    // 词汇加载失败 / 作者词汇非法：不按无词汇导出（产物会与执行语义不符），按 503 / 400 拒绝
    return versionVocabularyErrorResponse(error, headers) ?? upstreamError(error, headers);
  }
}
