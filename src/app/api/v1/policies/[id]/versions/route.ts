/**
 * 版本列表 API 端点
 *
 * GET  - 获取策略的所有版本
 * POST - 创建新版本
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { internalErrorResponse } from '@/lib/api/version-action-error';

import {
  createVersion,
  listVersions,
  listExecutableVersions,
  loadVersionReviewContext,
  PolicyCompileError,
} from '@/services/policy/version-manager';
import { canReviewPolicyVersions } from '@/services/policy/version-approval-rules';
import { loadSaveVocabulary, makeCompileValidator } from '@/lib/policy-compile-validator';
import {
  aliasInvalidResponse,
  compileGateErrorResponse,
  vocabularyScopeInvalidResponse,
} from '@/lib/policy-compile-response';
import {
  getStructuralAliasGrant,
  buildAliasReservedForUser,
} from '@/lib/structural-alias-grants';
import { db, policies } from '@/lib/prisma';
import { and, eq, isNull } from 'drizzle-orm';
import { isPolicyFrozen } from '@/lib/policy-freeze';
import { parseCompileLocale } from '@/lib/cnl-locale';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/v1/policies/{id}/versions
 *
 * 获取策略的所有版本列表
 * 支持 ?executable=true 参数只返回可执行版本
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized', code: 'unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    // 读授权校验（IDOR 修复）：此前任何登录用户可列任意 policy id 的版本历史。
    // 口径：策略所有者、公开策略，或有权审阅该策略版本的人（团队策略的团队 owner/admin，
    // 他们要在版本页上批准/驳回）。其余团队成员的共享读暂不在此入口放开。
    const readable = await db.query.policies.findFirst({
      where: and(
        eq(policies.id, id),
        isNull(policies.deletedAt),
      ),
      columns: { userId: true, isPublic: true },
    });
    const reviewer = readable && readable.userId !== session.user.id && !readable.isPublic
      ? await loadVersionReviewContext(id, session.user.id)
      : null;
    const allowed = readable
      && (readable.userId === session.user.id || readable.isPublic || (reviewer && canReviewPolicyVersions(reviewer)));
    if (!allowed) {
      return NextResponse.json({ error: 'Policy not found.', code: 'policy_not_found' }, { status: 404 });
    }

    const executableOnly =
      request.nextUrl.searchParams.get('executable') === 'true';

    const versions = executableOnly
      ? await listExecutableVersions(id)
      : await listVersions(id);

    return NextResponse.json({ versions });
  } catch (error) {
    console.error('[Versions GET] Error:', error);
    return NextResponse.json(
      { error: 'Could not load versions.', code: 'version_list_failed' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/v1/policies/{id}/versions
 *
 * 创建新版本
 * Body: { source: string, releaseNote?: string }
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized', code: 'unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    // 授权校验（IDOR 修复）：此前该入口只查登录态，任何登录用户可对任意 policy id 建版本
    // （现还能携 aliasSet）。与 PUT /api/policies/[id] 同口径——要求是策略所有者且未软删；
    // 冻结策略只读。团队写权限暂未支持（与 PUT 一致，避免此处口径超前）。
    const owned = await db.query.policies.findFirst({
      where: and(
        eq(policies.id, id),
        eq(policies.userId, session.user.id),
        isNull(policies.deletedAt),
      ),
      columns: { id: true },
    });
    if (!owned) {
      return NextResponse.json({ error: 'Policy not found.', code: 'policy_not_found' }, { status: 404 });
    }
    const freeze = await isPolicyFrozen(session.user.id, id);
    if (freeze.isFrozen) {
      return NextResponse.json(
        { error: 'Policy is frozen.', code: 'policy_frozen', frozen: true },
        { status: 403 },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'Request body must be valid JSON.', code: 'invalid_json' },
        { status: 400 }
      );
    }

    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Request body must be a valid object.', code: 'invalid_request_body' },
        { status: 400 }
      );
    }

    const { source, releaseNote, aliasSet, locale } = body as {
      source?: string;
      releaseNote?: string;
      aliasSet?: unknown;
      locale?: unknown;
    };

    if (!source || typeof source !== 'string') {
      return NextResponse.json(
        { error: 'source is required.', code: 'source_required' },
        { status: 400 }
      );
    }

    // 关键词别名（ADR 0022）：此入口同样走 version-manager 的可信路径——校验 + canonical +
    // envelope 冻结 + 审计。绝不静默忽略 aliasSet（此前忽略 → 别名策略在此入口丢别名）。
    // allowStructural 从服务端 per-user entitlement 权威取（不信 body）；aliasReserved server 组装。
    const aliasSetInput =
      aliasSet &&
      typeof aliasSet === 'object' &&
      !Array.isArray(aliasSet) &&
      Object.keys(aliasSet as Record<string, unknown>).length > 0
        ? (aliasSet as Record<string, string[]>)
        : null;
    const parsedLocale = parseCompileLocale(locale);
    if (!parsedLocale.ok) return NextResponse.json(parsedLocale.error, { status: 400 });
    const compileLocale = parsedLocale.locale;
    const allowStructural = aliasSetInput
      ? await getStructuralAliasGrant(session.user.id)
      : false;
    const aliasReserved = aliasSetInput
      ? await buildAliasReservedForUser(session.user.id, compileLocale)
      : undefined;

    // 作者词汇只加载一次，编译门禁与 envelope 封印共用（ADR 0051 §7）。
    const saveVocabulary = await loadSaveVocabulary(session.user.id, { source, locale: compileLocale });

    const result = await createVersion({
      policyId: id,
      source,
      createdBy: session.user.id,
      releaseNote,
      locale: compileLocale,
      scopesJson: saveVocabulary.scopesJson,
      aliasSet: aliasSetInput,
      aliasReserved,
      allowStructuralAliases: allowStructural,
      validateCompilable: makeCompileValidator(session.user.id, saveVocabulary.vocabulary),
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    // 编译门禁拒绝：源码有阻断诊断 → 400；编译检查暂不可用 → 503 可重试。
    if (error instanceof PolicyCompileError) {
      return compileGateErrorResponse(error);
    }
    const aliasInvalid = aliasInvalidResponse(error);
    if (aliasInvalid) return aliasInvalid;
    const vocabularyInvalid = vocabularyScopeInvalidResponse(error);
    if (vocabularyInvalid) return vocabularyInvalid;
    return internalErrorResponse('Versions POST', error, 'Could not create version.');
  }
}
