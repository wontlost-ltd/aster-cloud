/*
 * 导出为策略包（ADR 0059 P2，T18）。
 * POST /api/policies/[id]/export/package，请求体 `{ target: 'jre' | 'node', entry?: string, uiLocale?: 'en' | 'zh' | 'de' | 'hi' }`。
 *
 * 只导出执行路径会选中的已批准版本（findDefaultExecutableVersion，无则 409，同 Cedar）。编译输入与详情页的
 * 可导出性检查同一份（package-export-input）；aster-api 编译、检查、生成探针、组装确定性 zip、签名并写审计，
 * 本路由只把 zip 字节与 aster-api 给出的头原样转发给浏览器（zip 哈希即审计链里的同一值）。
 *
 * 门控顺序：会话 401 → 开关 policy_export.package.enabled 关 404 → 限流 429 → 请求体 400 → 访问（团队任一成员 /
 * 个人策略所有者，非成员 404）→ 计划门 policyExport（按 planHolderForTeam）403 → 无已批准版本 409 → 编译输入 →
 * 入口名归一（不属于该版本 400）→ target=node：prepare 后在 Worker 内复核（ts 版本漂移 503 export_runtime_skew，
 * 重编译漂移 E739、探针不一致 E735 均按不可导出返回诊断），通过后带 nodeProbes → 导出。
 *
 * 显示排版（ADR 0059 修订 4 D11）：loadExportLayout 读同一版本的排版并复跑保存校验（开关 policy_export.package.layout.enabled
 * 关、读取复验不过、校验不过 → 不发送）；target=node 时 Worker 复核另用 ts 跑 L1–L9，不过同样不发送（node_display_check_failed）。
 * 排版问题只省略排版、不拒绝导出。响应头 X-Aster-Package-Layout(-Reason)：cloud 没发送时以 cloud 的原因为准
 * （此时上游必然返回 absent），否则原样转发 aster-api 的结论。
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { loadPolicyForAction, policyAccessDeniedResponse } from '@/lib/policy-access';
import { checkRateLimit, getRateLimitHeaders, RateLimitPresets } from '@/lib/rate-limit';
import { policyTenantId } from '@/lib/policy-tenant';
import { createPolicyApiClientForUser } from '@/lib/policy-api-identity';
import { versionVocabularyErrorResponse } from '@/lib/policy-compile-response';
import { resolvePolicyRuleName } from '@/lib/cedar-export-rules';
import { registeredUpstreamMessage } from '@/lib/upstream-error-messages';
import { isPolicyPackageExportEnabled } from '@/lib/platform-settings';
import { planHolderForTeam } from '@/lib/team-plan';
import { hasFeatureAccess } from '@/lib/usage';
import { loadPackageExportInput } from '@/lib/package-export-input';
import { safeDiagnostics } from '@/lib/package-diagnostics';
import { runNodeCheck } from '@/lib/package-node-check';
import { loadExportLayout } from '@/lib/package-export-layout';
import type { DomainVocabulary } from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';
import {
  PACKAGE_LAYOUT_HEADER,
  PACKAGE_LAYOUT_REASON_HEADER,
  type CloudLayoutReason,
  type PackageLayoutOutcome,
} from '@/lib/package-layout-outcome';
import { recordProductEventAfterResponse } from '@/lib/product-events/server';
import { findDefaultExecutableVersion } from '@/services/policy/default-executable-version';
import {
  PACKAGE_EXPORT_TARGETS,
  PolicyApiError,
  type PackageExportRequest,
  type PackageExportTarget,
  type PackageExportUiLocale,
} from '@/services/policy/policy-api';

interface RouteParams {
  params: Promise<{ id: string }>;
}

const UI_LOCALES: readonly PackageExportUiLocale[] = ['en', 'zh', 'de', 'hi'];

/** 上游 503 中可透传给面板的码（面板按码给出本地化提示；Retry-After 一并透传） */
const PASS_THROUGH_503: ReadonlySet<string> = new Set([
  'package_export_busy',
  'export_signing_unavailable',
  'export_signing_kid_unanchored',
  'export_runtime_unavailable',
]);

/** 上游 4xx 中可透传的码（同 Cedar 的 #711 规则：只透传登记过的稳定码，文案换成英文） */
const PASS_THROUGH_4XX: ReadonlySet<string> = new Set(['alias_set_too_large', 'vocabulary_too_large']);

const EXPORT_FAILED_MESSAGE = 'Policy package export failed. Please try again later.';

const UPSTREAM_503_MESSAGES: Readonly<Record<string, string>> = {
  package_export_busy: 'Package export is busy. Please try again shortly.',
  export_signing_unavailable: 'Package signing is not configured on this platform.',
  export_signing_kid_unanchored: 'The package signing key is not yet trusted by the published CLI.',
  export_runtime_unavailable: 'This package target is not available yet.',
};

interface ExportBody {
  target: PackageExportTarget;
  entry?: string;
  uiLocale: PackageExportUiLocale;
}

async function readBody(req: Request): Promise<ExportBody | { error: string; message: string }> {
  let body: unknown;
  try {
    body = JSON.parse(await req.text());
  } catch {
    body = null;
  }
  const raw = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  if (typeof raw.target !== 'string' || !(PACKAGE_EXPORT_TARGETS as readonly string[]).includes(raw.target)) {
    return { error: 'invalid_target', message: "target must be 'jre' or 'node'" };
  }
  if (raw.entry !== undefined && raw.entry !== null && (typeof raw.entry !== 'string' || !raw.entry.trim())) {
    return { error: 'invalid_entry', message: 'entry must be a non-empty string' };
  }
  const uiLocale = typeof raw.uiLocale === 'string' && (UI_LOCALES as readonly string[]).includes(raw.uiLocale)
    ? (raw.uiLocale as PackageExportUiLocale)
    : 'en';
  return {
    target: raw.target as PackageExportTarget,
    uiLocale,
    ...(typeof raw.entry === 'string' ? { entry: raw.entry.trim() } : {}),
  };
}

/**
 * 上游错误映射：503 已登记码透传（带 Retry-After）；400 entry_required 透传候选；登记过的 4xx 透传码与英文文案；
 * 其余（5xx、身份配置、网络、内部异常、未登记 4xx）一律 502 通用文案 + requestId，原文只进服务端日志（#688）。
 */
function upstreamError(error: unknown, headers: Headers): NextResponse {
  if (error instanceof PolicyApiError && error.code) {
    if (error.statusCode === 503 && PASS_THROUGH_503.has(error.code)) {
      if (error.retryAfter) headers.set('Retry-After', error.retryAfter);
      return NextResponse.json(
        { error: error.code, code: error.code, message: UPSTREAM_503_MESSAGES[error.code] },
        { status: 503, headers },
      );
    }
    if (error.statusCode === 400 && error.code === 'entry_required') {
      const raw = error.details?.entryCandidates;
      const entryCandidates = Array.isArray(raw) ? raw.filter((e): e is string => typeof e === 'string') : [];
      return NextResponse.json(
        { error: 'entry_required', code: 'entry_required', message: 'Choose the entry function to export.', entryCandidates },
        { status: 400, headers },
      );
    }
    const message = registeredUpstreamMessage(error.code);
    if (PASS_THROUGH_4XX.has(error.code) && error.statusCode >= 400 && error.statusCode < 500 && message) {
      console.warn('[api/policies/export/package] upstream rejected', error.code);
      return NextResponse.json({ success: false, error: error.code, code: error.code, message }, { status: 502, headers });
    }
  }
  const requestId = crypto.randomUUID();
  console.error(`[api/policies/export/package] upstream error requestId=${requestId}`, error);
  headers.set('x-request-id', requestId);
  return NextResponse.json(
    { success: false, error: 'package_export_failed', code: 'package_export_failed', message: EXPORT_FAILED_MESSAGE, requestId },
    { status: 502, headers },
  );
}

export async function POST(req: Request, { params }: RouteParams) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  // 开关关时整个端点不存在（与 aster-api 侧开关同一口径）
  if (!(await isPolicyPackageExportEnabled())) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const limit = checkRateLimit(`policy-package-export:${userId}`, RateLimitPresets.EVALUATE_SOURCE);
  const headers = new Headers(getRateLimitHeaders(limit, RateLimitPresets.EVALUATE_SOURCE));
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded', retryAfter: limit.retryAfterSeconds }, { status: 429, headers });
  }

  const body = await readBody(req);
  if ('error' in body) return NextResponse.json(body, { status: 400, headers });

  const { id } = await params;
  // 团队策略任一成员可导出（只读），个人策略只认所有者；非成员 404
  const access = await loadPolicyForAction(id, { userId }, 'view');
  if (!access.ok) return policyAccessDeniedResponse(access.decision, { headers });
  const policy = access.policy;

  const holder = await planHolderForTeam(userId, policy.teamId);
  if (!(await hasFeatureAccess(holder, 'policyExport'))) {
    return NextResponse.json(
      { error: 'policy_export_requires_plan', code: 'policy_export_requires_plan', upgrade: true },
      { status: 403, headers },
    );
  }

  const version = await findDefaultExecutableVersion(policy.id);
  if (!version) return NextResponse.json({ error: 'no executable version' }, { status: 409, headers });

  try {
    const { request, source, vocabulary } = await loadPackageExportInput(policy, version);
    const entry = body.entry && resolvePolicyRuleName(source, vocabulary, body.entry);
    if (entry === null) {
      return NextResponse.json({ error: 'unknown_function', message: 'entry is not a rule of this policy version' }, { status: 400, headers });
    }
    const client = await createPolicyApiClientForUser(policyTenantId(policy), userId);
    const exportRequest: PackageExportRequest = {
      ...request,
      target: body.target,
      uiLocale: body.uiLocale,
      ...(entry ? { entry } : {}),
    };
    const exportLayout = await loadExportLayout({
      id: version.id,
      source,
      locale: request.locale,
      aliasSet: request.aliasSet ?? null,
      allowStructural: request.allowStructural === true,
      vocabulary: (vocabulary ?? null) as DomainVocabulary | null,
    });
    let layout = exportLayout.kind === 'included' ? exportLayout.layout : undefined;
    let cloudReason: CloudLayoutReason | null = exportLayout.kind === 'omitted' ? exportLayout.reason : null;
    let nodeProbes: PackageExportRequest['nodeProbes'];
    // Node 包须先在 Worker 内重编译并比对探针（修订 3 P2-R5 / P2-R13），通过后才交 aster-api 签名
    if (body.target === 'node') {
      const prepared = await client.preparePackageExport(exportRequest);
      if (!prepared.exportable) {
        return NextResponse.json({ exportable: false, diagnostics: safeDiagnostics(prepared.diagnostics) }, { headers });
      }
      const check = runNodeCheck(prepared, request, layout);
      if ('skew' in check) {
        console.warn('[api/policies/export/package] node runtime skew', prepared.runtime?.cliVersion);
        return NextResponse.json(
          { error: 'export_runtime_skew', code: 'export_runtime_skew', message: 'Node package export is not available on this platform version.' },
          { status: 503, headers },
        );
      }
      if (!check.ok) return NextResponse.json({ exportable: false, diagnostics: check.diagnostics }, { headers });
      nodeProbes = check.nodeProbes;
      if (layout !== undefined && !check.layoutOk) {
        console.warn('[api/policies/export/package] node display check failed; exporting without layout');
        layout = undefined;
        cloudReason = 'node_display_check_failed';
      }
    }
    const result = await client.exportPackage({
      ...exportRequest,
      ...(nodeProbes ? { nodeProbes } : {}),
      ...(layout !== undefined ? { layout } : {}),
    });
    if (result.kind === 'refused') {
      return NextResponse.json({ exportable: false, diagnostics: result.diagnostics }, { headers });
    }
    recordProductEventAfterResponse('policy_package_exported', {
      userId,
      tenantId: policyTenantId(policy),
      properties: { target: body.target, signed: result.signed },
    });
    headers.set('Content-Type', 'application/zip');
    headers.set('Content-Disposition', result.contentDisposition
      || `attachment; filename="policy-package.zip"; filename*=UTF-8''${encodeURIComponent(result.filename)}`);
    headers.set('X-Aster-Package-Sha256', result.sha256);
    headers.set('X-Aster-Package-Signed', String(result.signed));
    const layoutOutcome: PackageLayoutOutcome = cloudReason ? { status: 'omitted', reason: cloudReason } : result.layout;
    headers.set(PACKAGE_LAYOUT_HEADER, layoutOutcome.status);
    if (layoutOutcome.status === 'omitted' && layoutOutcome.reason) headers.set(PACKAGE_LAYOUT_REASON_HEADER, layoutOutcome.reason);
    headers.set('Cache-Control', 'private, no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
    return new NextResponse(result.bytes, { status: 200, headers });
  } catch (error) {
    // 词汇加载失败 / 作者词汇非法：不按无词汇导出，按 503 / 400 拒绝（同 Cedar）
    return versionVocabularyErrorResponse(error, headers) ?? upstreamError(error, headers);
  }
}
