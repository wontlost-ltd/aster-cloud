// 用户 BYOK 管理 API
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, aiKeyBindings } from '@/lib/prisma';
import { eq } from 'drizzle-orm';
import {
  saveBYOKKey,
  deleteBYOKKey,
  updateBYOKKeyMeta,
  reorderBYOKKeys,
  updateBYOKAvailableModels,
  getDecryptedBYOKKeyById,
  findBindingForUser,
} from '@/lib/ai-key-vault';
import { fetchByokModels, MODEL_ID_RE, unverifiedReason, type UnverifiedReason } from '@/lib/byok-models';
import { errorEnvelope } from '@/lib/api/error-envelope';
import { byokTokensUsedThisMonth, resetByokQuotaUsage } from '@/lib/ai-quota';
import { logAuditEvent, extractClientInfo } from '@/lib/audit-log';

/**
 * model 字段规范化（与 aster-api ByokEnvelopeParser.normalizeModel 同语义）：
 * undefined=未提供（PATCH 不改）；null / 空串 / 纯空白 = 清空（平台默认）；
 * 否则 trim 后须符合 MODEL_ID_RE。返回 { ok: false } 表示形状非法。
 */
function parseModelField(raw: unknown): { ok: true; model: string | null | undefined } | { ok: false } {
  if (raw === undefined) return { ok: true, model: undefined };
  if (raw === null) return { ok: true, model: null };
  if (typeof raw !== 'string') return { ok: false };
  const m = raw.trim();
  if (m === '') return { ok: true, model: null };
  return MODEL_ID_RE.test(m) ? { ok: true, model: m } : { ok: false };
}

/**
 * 填了 model 时经 aster-api 查 provider 列表（ADR 0048 §3.4）：列表存在且不含该 model → 拒绝；
 * 查询失败（provider 抖动）或网关不提供列表 → 放行。
 */
async function checkModelAgainstProvider(
  userId: string,
  creds: { provider: string; apiKey: string; baseUrl: string | null },
  model: string | null,
): Promise<{ result: Awaited<ReturnType<typeof fetchByokModels>> } | { rejected: string[] }> {
  const result = await fetchByokModels(userId, creds);
  if (result.ok && result.models && model && !result.models.includes(model)) {
    return { rejected: result.models };
  }
  return { result };
}

/**
 * 回写可用模型列表缓存（降级写）：校验已成功，缓存写失败不应让保存/编辑整体 500
 * （key 行可能已入库，用户重试会产生重复 key）。仅告警，调用方照常返回 modelsChecked。
 */
async function writeAvailableModels(
  id: string,
  result: { models: string[] | null; defaultModel: string },
): Promise<void> {
  try {
    await updateBYOKAvailableModels(id, { models: result.models, defaultModel: result.defaultModel });
  } catch (e) {
    console.warn('[ai-keys] availableModels write failed for binding=%s:', id, e);
  }
}

/**
 * 列表查询失败时的响应字段：modelsChecked=false + 稳定原因码（让 UI 说明为何未校验），
 * 并以 binding id 告警，便于运维对照 aster-api 日志。只记 error 码，绝不记 key。
 */
function unverified(
  bindingId: string,
  error: string,
): { modelsChecked: false; unverifiedReason: UnverifiedReason } {
  console.warn('[ai-keys] models check failed for binding=%s: %s', bindingId, error);
  return { modelsChecked: false, unverifiedReason: unverifiedReason(error) };
}

function modelNotAvailable(available: string[]) {
  return NextResponse.json({ error: 'model_not_available', available }, { status: 400 });
}

/**
 * PATCH update 携带非空 model 时的校验：归属校验先于解密（不属于本人 → 404），
 * vertex 不查列表；列表查询失败放行（modelsChecked=false），成功则回写可用列表缓存。
 */
async function validatePatchModel(
  userId: string,
  bindingId: string,
  model: string,
): Promise<NextResponse | { modelsChecked?: boolean; unverifiedReason?: UnverifiedReason }> {
  const binding = await findBindingForUser(userId, bindingId);
  if (!binding) {
    return NextResponse.json({ error: 'AI key not found' }, { status: 404 });
  }
  if (binding.provider === 'vertex') return {};

  const apiKey = await getDecryptedBYOKKeyById(userId, bindingId);
  if (!apiKey) {
    return NextResponse.json({ error: 'AI key not found' }, { status: 404 });
  }
  const check = await checkModelAgainstProvider(
    userId,
    { provider: binding.provider, apiKey, baseUrl: binding.providerUrl },
    model,
  );
  if ('rejected' in check) return modelNotAvailable(check.rejected);
  if (!check.result.ok) return unverified(bindingId, check.result.error);
  await writeAvailableModels(bindingId, check.result);
  return { modelsChecked: true };
}

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 多 key：按 (provider, priority, createdAt) 排序，前端按调用优先级顺序展示同 provider 的多 key。
    const bindings = await db.query.aiKeyBindings.findMany({
      where: eq(aiKeyBindings.userId, session.user.id),
      columns: {
        id: true,
        provider: true,
        keyHint: true,
        active: true,
        providerUrl: true,
        tokenQuota: true,
        expiresAt: true,
        priority: true,
        lastUsedAt: true,
        lastErrorAt: true,
        lastError: true,
        createdAt: true,
        model: true,
        availableModels: true,
        modelsCheckedAt: true,
      },
      orderBy: (t, { asc }) => [asc(t.provider), asc(t.priority), asc(t.createdAt)],
    });

    // 附本月已用 BYOK tokens（UI 显示「剩余额度」）。
    // ⚠️ aiUsageRecords 无 provider 列 → 只能给**每用户** BYOK 总量（跨所有 key 共享）,
    //    非 per-provider。tokenQuota 也据此按用户总量 enforce（见 ai-quota checkAiQuota）。
    const usedTokensThisMonth = await byokTokensUsedThisMonth(session.user.id);
    const enriched = bindings.map((b) => ({ ...b, usedTokensThisMonth }));

    return NextResponse.json({ bindings: enriched });
  } catch (err) {
    const env = errorEnvelope({
      status: 500,
      code: 'service_unavailable',
      message: 'Could not load AI keys. Please retry; the failure has been logged.',
    });
    console.error(
      '[ai-keys GET] handler failed',
      env.headers.get('x-request-id'),
      err,
    );
    return env;
  }
}

export async function POST(req: Request) {
  // Wrap the BYOK write in try/catch so failures inside saveBYOKKey()
  // — pgcrypto missing, AI_KEY_ENCRYPTION_SECRET missing / too short,
  // Hyperdrive timeout, anything thrown by pgp_sym_encrypt — return a
  // structured 5xx envelope with a requestId rather than Next's
  // opaque HTML 500 page. The underlying message is logged with the
  // same requestId so on-call can correlate.
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await req.json()) as {
      provider: string;
      apiKey: string;
      providerUrl?: string | null;
      tokenQuota?: number | null;
      expiresAt?: string | null;
      model?: string | null;
    };
    if (!body.apiKey || body.apiKey.length < 20) {
      return NextResponse.json({ error: 'Invalid API key' }, { status: 400 });
    }
    if (!['openai', 'anthropic', 'vertex'].includes(body.provider)) {
      return NextResponse.json({ error: 'Unsupported provider' }, { status: 400 });
    }

    // providerUrl：可选,非空则须是合法 https URL（防 SSRF/明文）。
    let providerUrl: string | null = null;
    if (body.providerUrl != null && body.providerUrl !== '') {
      try {
        const u = new URL(body.providerUrl);
        if (u.protocol !== 'https:') {
          return NextResponse.json({ error: 'providerUrl must be https' }, { status: 400 });
        }
        providerUrl = u.toString();
      } catch {
        return NextResponse.json({ error: 'Invalid providerUrl' }, { status: 400 });
      }
    }

    // tokenQuota：可选正整数。
    let tokenQuota: number | null = null;
    if (body.tokenQuota != null) {
      if (!Number.isInteger(body.tokenQuota) || body.tokenQuota <= 0) {
        return NextResponse.json({ error: 'tokenQuota must be a positive integer' }, { status: 400 });
      }
      tokenQuota = body.tokenQuota;
    }

    // expiresAt：可选,须是未来时间。
    let expiresAt: Date | null = null;
    if (body.expiresAt != null && body.expiresAt !== '') {
      const d = new Date(body.expiresAt);
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json({ error: 'Invalid expiresAt' }, { status: 400 });
      }
      if (d.getTime() <= Date.now()) {
        return NextResponse.json({ error: 'expiresAt must be in the future' }, { status: 400 });
      }
      expiresAt = d;
    }

    const parsedModel = parseModelField(body.model);
    if (!parsedModel.ok) {
      return NextResponse.json({ error: 'Invalid model' }, { status: 400 });
    }
    const model = parsedModel.model ?? null;

    // 保存前经 aster-api 查一次 provider 模型列表（ADR 0048 §3.4）：填了 model 就校验存在；
    // 查询失败不阻断保存（provider 抖动不该让用户存不了 key），只是不写 availableModels。
    let models: Awaited<ReturnType<typeof fetchByokModels>> | null = null;
    if (body.provider !== 'vertex') {
      const check = await checkModelAgainstProvider(
        session.user.id,
        { provider: body.provider, apiKey: body.apiKey, baseUrl: providerUrl },
        model,
      );
      if ('rejected' in check) return modelNotAvailable(check.rejected);
      models = check.result;
    }

    // 多 key：POST **总是新增一行**（同 provider 可多个 key）。返回新 binding id。
    const { id } = await saveBYOKKey({
      userId: session.user.id,
      provider: body.provider as 'openai' | 'anthropic' | 'vertex',
      apiKey: body.apiKey,
      providerUrl,
      tokenQuota,
      expiresAt,
      model,
    });

    if (models?.ok) {
      await writeAvailableModels(id, models);
    }
    const checkFields = models && !models.ok ? unverified(id, models.error) : { modelsChecked: models?.ok === true };

    // 审计（管理员可追溯）：只记 binding id / provider / keyHint（后 4 位）/ 是否设了 url/额度/失效
    // 日期，**绝不**记明文 key。多 key 下 POST 一律是 create。
    const { ipAddress, userAgent } = extractClientInfo(req);
    await logAuditEvent({
      userId: session.user.id,
      action: 'ai-key.create',
      resource: 'ai-key',
      resourceId: id,
      metadata: {
        bindingId: id,
        provider: body.provider,
        keyHint: body.apiKey.slice(-4),
        hasProviderUrl: providerUrl != null,
        tokenQuota,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        model,
      },
      ipAddress,
      userAgent,
    });

    return NextResponse.json({
      ok: true,
      id,
      ...checkFields,
      availableModels: models?.ok ? models.models : undefined,
    });
  } catch (err) {
    const env = errorEnvelope({
      status: 500,
      code: 'service_unavailable',
      message: 'Could not save the AI key. Please retry; the failure has been logged.',
    });
    console.error(
      '[ai-keys POST] handler failed',
      env.headers.get('x-request-id'),
      err,
    );
    return env;
  }
}

/**
 * 编辑既有 BYOK key 的额度/失效日期/model（不重输 key），或重置本月已用额度。
 *   - { id, tokenQuota?, expiresAt?, action?: 'update' }：改额度上限 / 失效日期。字段不传=不动；
 *     传 null=清空（额度→无限 / 失效日期→永不过期）。
 *   - { action: 'resetQuota' }：把用户 BYOK 用量重置水位线盖成 now()（清「本月已用」显示，不删审计）。
 *   - { action: 'reorder', orderedIds }：按 id 顺序重排多 key 优先级（priority 0,1,2…）。
 * 全部经 userId 归属校验；每个动作写 AuditLog（管理员可追溯，不记明文 key）。
 */
export async function PATCH(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const userId = session.user.id;
    const { ipAddress, userAgent } = extractClientInfo(req);

    const body = (await req.json()) as {
      id?: string;
      action?: 'update' | 'resetQuota' | 'reorder';
      tokenQuota?: number | null;
      expiresAt?: string | null;
      model?: string | null;
      provider?: string;
      orderedIds?: string[];
    };

    // ── 重置本月已用额度 ──
    if (body.action === 'resetQuota') {
      const resetAt = await resetByokQuotaUsage(userId);
      await logAuditEvent({
        userId,
        action: 'ai-key.reset-quota',
        resource: 'ai-key',
        metadata: { resetAt: resetAt.toISOString() },
        ipAddress,
        userAgent,
      });
      return NextResponse.json({ ok: true, resetAt: resetAt.toISOString() });
    }

    // ── 重排多 key 优先级（限定单个 provider 组）──
    if (body.action === 'reorder') {
      const provider = body.provider;
      const orderedIds = body.orderedIds;
      if (typeof provider !== 'string' || provider.length === 0) {
        return NextResponse.json({ error: 'provider is required for reorder' }, { status: 400 });
      }
      if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
        return NextResponse.json({ error: 'orderedIds must be a non-empty array' }, { status: 400 });
      }
      if (!orderedIds.every((x) => typeof x === 'string' && x.length > 0)) {
        return NextResponse.json({ error: 'orderedIds must be non-empty strings' }, { status: 400 });
      }
      // 去重防御：同一 id 出现两次会让 CASE 语义歧义。
      if (new Set(orderedIds).size !== orderedIds.length) {
        return NextResponse.json({ error: 'orderedIds must be unique' }, { status: 400 });
      }
      const updated = await reorderBYOKKeys(userId, provider, orderedIds);
      // 完整归属校验（Codex 审查）：改到的行数必须**等于** orderedIds 数量——否则说明 orderedIds
      // 含不属于该 (user, provider) 的 id（越权/跨 provider/已删）。此时不写成功审计，返回 404
      // （不泄露哪个 id 无效）。已被 UPDATE 改到的行会随后续 refresh/正确重排对齐；此处 fail-fast。
      if (updated !== orderedIds.length) {
        return NextResponse.json({ error: 'AI keys not found' }, { status: 404 });
      }
      await logAuditEvent({
        userId,
        action: 'ai-key.reorder',
        resource: 'ai-key',
        // 只记 provider + id 顺序（管理员可追溯优先级变更），不含明文 key。
        metadata: { provider, orderedIds },
        ipAddress,
        userAgent,
      });
      return NextResponse.json({ ok: true });
    }

    // ── 编辑额度上限 / 失效日期（不重输 key）──
    if (!body.id) {
      return NextResponse.json({ error: 'Missing id' }, { status: 400 });
    }

    // tokenQuota：未提供=不动（undefined）；null=清空（改无限）；否则须正整数。
    let tokenQuota: number | null | undefined = undefined;
    if ('tokenQuota' in body) {
      if (body.tokenQuota === null) {
        tokenQuota = null;
      } else if (!Number.isInteger(body.tokenQuota) || (body.tokenQuota as number) <= 0) {
        return NextResponse.json({ error: 'tokenQuota must be a positive integer' }, { status: 400 });
      } else {
        tokenQuota = body.tokenQuota as number;
      }
    }

    // expiresAt：未提供=不动；null 或空串=清空（永不过期）；否则须未来时间。
    let expiresAt: Date | null | undefined = undefined;
    if ('expiresAt' in body) {
      if (body.expiresAt == null || body.expiresAt === '') {
        expiresAt = null;
      } else {
        const d = new Date(body.expiresAt);
        if (Number.isNaN(d.getTime())) {
          return NextResponse.json({ error: 'Invalid expiresAt' }, { status: 400 });
        }
        if (d.getTime() <= Date.now()) {
          return NextResponse.json({ error: 'expiresAt must be in the future' }, { status: 400 });
        }
        expiresAt = d;
      }
    }

    // model：与新建同语义（undefined 不动 / null 或空白清空 / 字符串须合法）。
    const parsedModel = parseModelField(body.model);
    if (!parsedModel.ok) {
      return NextResponse.json({ error: 'Invalid model' }, { status: 400 });
    }
    const model = parsedModel.model;

    if (tokenQuota === undefined && expiresAt === undefined && model === undefined) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
    }

    // 改 model 与新建同一校验路径：解密**本人**这条 key（归属不符 → 404，不解密），经 aster-api 查列表。
    let checkFields: { modelsChecked?: boolean; unverifiedReason?: UnverifiedReason } = {};
    if (typeof model === 'string') {
      const validated = await validatePatchModel(userId, body.id, model);
      if (validated instanceof NextResponse) return validated;
      checkFields = validated;
    }

    const updated = await updateBYOKKeyMeta({ userId, bindingId: body.id, tokenQuota, expiresAt, model });
    if (!updated) {
      // 没有匹配行 = 越权改别人的 key 或该 key 已删。不泄露存在性，统一 404。
      return NextResponse.json({ error: 'AI key not found' }, { status: 404 });
    }

    await logAuditEvent({
      userId,
      action: 'ai-key.update',
      resource: 'ai-key',
      resourceId: updated.provider,
      metadata: {
        provider: updated.provider,
        keyHint: updated.keyHint,
        // 只记「改了哪些字段 + 新值」，便于管理员回溯；不记明文 key。
        ...(tokenQuota !== undefined ? { tokenQuota } : {}),
        ...(expiresAt !== undefined ? { expiresAt: expiresAt ? expiresAt.toISOString() : null } : {}),
        ...(model !== undefined ? { model } : {}),
      },
      ipAddress,
      userAgent,
    });

    return NextResponse.json({ ok: true, ...checkFields });
  } catch (err) {
    const env = errorEnvelope({
      status: 500,
      code: 'service_unavailable',
      message: 'Could not update the AI key. Please retry; the failure has been logged.',
    });
    console.error('[ai-keys PATCH] handler failed', env.headers.get('x-request-id'), err);
    return env;
  }
}

export async function DELETE(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    // 多 key：按 binding **id** 删（同 provider 多 key，不能再按 provider 一删一片）。
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: 'Missing id' }, { status: 400 });
    }

    // 撤销 = 硬删除整行（含加密 key + 历史）。用户诉求「删除该 AI Key」+ 隐私。
    const { deleted, provider, keyHint } = await deleteBYOKKey(session.user.id, id);

    // 审计（管理员可追溯）：记 binding id + provider + keyHint + 是否真的删到行（deleted=false=
    // 无匹配 no-op，含越权删别人 id 的情形）。不记明文 key。
    const { ipAddress, userAgent } = extractClientInfo(req);
    await logAuditEvent({
      userId: session.user.id,
      action: 'ai-key.delete',
      resource: 'ai-key',
      resourceId: id,
      metadata: { bindingId: id, provider, deleted, keyHint },
      ipAddress,
      userAgent,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    const env = errorEnvelope({
      status: 500,
      code: 'service_unavailable',
      message: 'Could not delete the AI key. Please retry; the failure has been logged.',
    });
    console.error(
      '[ai-keys DELETE] handler failed',
      env.headers.get('x-request-id'),
      err,
    );
    return env;
  }
}
