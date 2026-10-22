// BYOK 加密存储辅助
//
// 用 Postgres pgcrypto 列加密；主密钥来自 env AI_KEY_ENCRYPTION_SECRET（Vault 注入）。
// 加密发生在 INSERT/UPDATE 时，解密只在 aster-api 调 LLM 时（in-memory，不入 log）。

import { db, aiKeyBindings } from '@/lib/prisma';
import { eq, and, asc, sql } from 'drizzle-orm';

function encryptionSecret(): string {
  const s = process.env.AI_KEY_ENCRYPTION_SECRET;
  if (!s || s.length < 16) {
    // Distinct error code so the BFF can tell deploy-config-missing
    // from runtime crypto failure. The route catches both as 503,
    // but the Worker log captures the .code for triage.
    const err = new Error(
      'AI_KEY_ENCRYPTION_SECRET is not set on the Worker (or < 16 chars). ' +
        'Set it via `wrangler secret put AI_KEY_ENCRYPTION_SECRET`.',
    );
    (err as Error & { code?: string }).code = 'ENCRYPTION_SECRET_MISSING';
    throw err;
  }
  return s;
}

/**
 * 保存或更新用户的 BYOK key
 * 后 4 位明文存入 keyHint；完整 key 用 pgp_sym_encrypt 加密
 */
export async function saveBYOKKey(params: {
  userId: string;
  provider: 'openai' | 'anthropic' | 'vertex';
  apiKey: string;
  /** 自定义 provider API base URL（可选）。null/undefined = 用内置默认。 */
  providerUrl?: string | null;
  /** BYOK 月度 token 上限（可选）。null/undefined = 无限。 */
  tokenQuota?: number | null;
  /** 失效日期（可选）。null/undefined = 永不过期。 */
  expiresAt?: Date | null;
  /** 指定模型 id（可选）。null/undefined = 平台默认。 */
  model?: string | null;
}): Promise<{ id: string }> {
  const secret = encryptionSecret();
  const keyHint = params.apiKey.slice(-4);
  // 显式 null 化 undefined，让 SQL 把「未提供」写成 NULL（用户清空即恢复默认）。
  const providerUrl = params.providerUrl ?? null;
  const tokenQuota = params.tokenQuota ?? null;
  const expiresAt = params.expiresAt ? params.expiresAt.toISOString() : null;
  const model = params.model ?? null;
  const id = globalThis.crypto.randomUUID();

  // 多 key：新 key **总是新增一行**（不再按 provider upsert 覆盖）。priority = 该 provider
  // 现有最大 priority + 1，即追加到优先级末尾（新 key 默认排在既有 key 之后，用户可再调序）。
  // 首个 key 时 MAX 为 NULL → COALESCE 到 -1 → priority=0。
  await db.execute(sql`
    INSERT INTO "AiKeyBinding"
      ("id", "userId", "provider", "encryptedKey", "keyHint", "active",
       "providerUrl", "tokenQuota", "expiresAt", "model", "priority", "createdAt", "updatedAt")
    VALUES (
      ${id},
      ${params.userId},
      ${params.provider},
      pgp_sym_encrypt(${params.apiKey}::text, ${secret}::text)::text,
      ${keyHint},
      true,
      ${providerUrl},
      ${tokenQuota},
      ${expiresAt}::timestamp,
      ${model},
      (SELECT COALESCE(MAX("priority"), -1) + 1 FROM "AiKeyBinding"
        WHERE "userId" = ${params.userId} AND "provider" = ${params.provider}),
      NOW(),
      NOW()
    )
  `);
  return { id };
}

/**
 * 重排某用户某 **provider 组**内多个 key 的调用优先级：按 orderedIds 的**顺序**赋 priority 0,1,2…
 * （数值小=优先级高，先被推理层选中）。
 *
 * 归属 + 同组约束（Codex 审查）：UPDATE 限定 userId + **provider** + id ∈ orderedIds——
 *   - 传别人的 id → provider/userId 不匹配 → 不被动到；
 *   - 混入**其它 provider** 的 id → provider 不匹配 → 不被动到（不会把 openai/anthropic priority 混写）。
 * 用 .returning 拿实际改到的行 id，返回 count；路由据此校验 count === orderedIds.length，
 * 不匹配即拒（说明 orderedIds 含不属于该 user+provider 的 id）。
 * 单条 UPDATE + CASE 一次改完；priority 冲突不成问题（已无唯一约束）。
 */
export async function reorderBYOKKeys(
  userId: string,
  provider: string,
  orderedIds: string[],
): Promise<number> {
  if (orderedIds.length === 0) return 0;
  // ★THEN 的序号必须显式 ::int 转型：drizzle 把 ${i} 作为**绑定参数**，Postgres 对绑定参数在
  // CASE 表达式里默认推断为 text → 赋给 integer 列会报「column priority is of type integer but
  // expression is of type text」。故每个 THEN 值都 cast 到 int，让整个 CASE 结果类型为 integer。
  const cases = sql.join(
    orderedIds.map((id, i) => sql`WHEN ${id} THEN ${i}::int`),
    sql` `,
  );
  const idList = sql.join(
    orderedIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const res = await db.execute(sql`
    UPDATE "AiKeyBinding"
    SET "priority" = CASE "id" ${cases} END,
        "updatedAt" = NOW()
    WHERE "userId" = ${userId} AND "provider" = ${provider} AND "id" IN (${idList})
    RETURNING "id"
  `);
  // execute 返回受影响行（RETURNING）——稳妥取 length（不同封装形态兜底）。
  return Array.isArray(res) ? res.length : (res as { count?: number }).count ?? 0;
}

/**
 * 编辑既有 BYOK key 的额度上限 / 失效日期——**不重输 key**（key 密文/keyHint 不动）。
 *
 * 按 binding id + userId 双重定位（userId 防越权改别人的 key）。字段用「显式传入才改」语义：
 *   - tokenQuota / expiresAt 传 undefined = 不动该列；传 null = 清空（额度改无限 / 失效日期改永不过期）。
 * 返回受影响行数据的 provider/keyHint（供审计 metadata；调用方不必再查一次）。null=没有匹配行（越权或已删）。
 */
export async function updateBYOKKeyMeta(params: {
  userId: string;
  bindingId: string;
  tokenQuota?: number | null;
  expiresAt?: Date | null;
  /** undefined=不动；null=清空（回到平台默认）；字符串=写入。 */
  model?: string | null;
}): Promise<{ provider: string; keyHint: string } | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (params.tokenQuota !== undefined) set.tokenQuota = params.tokenQuota;
  if (params.expiresAt !== undefined) set.expiresAt = params.expiresAt;
  if (params.model !== undefined) set.model = params.model;

  const rows = await db
    .update(aiKeyBindings)
    .set(set)
    .where(and(eq(aiKeyBindings.id, params.bindingId), eq(aiKeyBindings.userId, params.userId)))
    .returning({ provider: aiKeyBindings.provider, keyHint: aiKeyBindings.keyHint });
  return rows[0] ?? null;
}

/**
 * 多 key 选择候选：返回某用户某 provider 下所有 **active** key 的**非机密**元数据，按调用优先级
 * 排序（priority asc，同 priority 用 createdAt asc 兜底稳定排序）。**不解密** key——选择层先按
 * expiresAt/quota 挑出可用的那个，再用 getDecryptedBYOKKeyById 只解密胜出的一个（避免解密不会用到的）。
 */
export interface ByokCandidate {
  id: string;
  provider: string;
  providerUrl: string | null;
  tokenQuota: number | null;
  expiresAt: Date | null;
  model: string | null;
}
/**
 * 某用户所有 **active** key 的候选列表（跨 provider），按调用优先级排序（priority asc，同 priority
 * 用 createdAt asc 兜底稳定排序）。**不解密**。选择层据此挑第一个可用 key（跳过过期/超额），
 * 再用 getDecryptedBYOKKeyById 只解密胜出的一个。可选 provider 过滤（限定某 provider 的候选）。
 */
export async function getBYOKCandidatesForInference(
  userId: string,
  provider?: string,
): Promise<ByokCandidate[]> {
  const where = provider
    ? and(
        eq(aiKeyBindings.userId, userId),
        eq(aiKeyBindings.provider, provider),
        eq(aiKeyBindings.active, true),
      )
    : and(eq(aiKeyBindings.userId, userId), eq(aiKeyBindings.active, true));
  const rows = await db
    .select({
      id: aiKeyBindings.id,
      provider: aiKeyBindings.provider,
      providerUrl: aiKeyBindings.providerUrl,
      tokenQuota: aiKeyBindings.tokenQuota,
      expiresAt: aiKeyBindings.expiresAt,
      model: aiKeyBindings.model,
    })
    .from(aiKeyBindings)
    .where(where)
    .orderBy(asc(aiKeyBindings.priority), asc(aiKeyBindings.createdAt));
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    providerUrl: r.providerUrl ?? null,
    tokenQuota: r.tokenQuota ?? null,
    expiresAt: r.expiresAt ?? null,
    model: r.model ?? null,
  }));
}

/** 与 aster-api / byok-models.ts 同一形状；入库前再收敛一次，jsonb 上界 ≤ 200×128 字符。 */
const MODEL_ID_RE = /^[A-Za-z0-9._:/-]{1,128}$/;
const MAX_AVAILABLE_MODELS = 200;

/** 写入最近一次模型列表查询结果（healthcheck / 保存时）。失败路径不调用本函数，旧列表保留。 */
export async function updateBYOKAvailableModels(
  bindingId: string,
  result: { models: string[] | null; defaultModel: string },
): Promise<void> {
  const models = result.models
    ? result.models.filter((m) => MODEL_ID_RE.test(m)).slice(0, MAX_AVAILABLE_MODELS)
    : null;
  await db
    .update(aiKeyBindings)
    .set({
      availableModels: { models, defaultModel: result.defaultModel },
      modelsCheckedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(aiKeyBindings.id, bindingId));
}

/** 按 (id, userId) 取 binding 的 provider / providerUrl（不解密），归属不符返回 null。 */
export async function findBindingForUser(
  userId: string,
  bindingId: string,
): Promise<{ id: string; provider: string; providerUrl: string | null } | null> {
  const rows = await db
    .select({ id: aiKeyBindings.id, provider: aiKeyBindings.provider, providerUrl: aiKeyBindings.providerUrl })
    .from(aiKeyBindings)
    .where(and(eq(aiKeyBindings.id, bindingId), eq(aiKeyBindings.userId, userId)))
    .limit(1);
  return rows[0] ? { ...rows[0], providerUrl: rows[0].providerUrl ?? null } : null;
}

/**
 * 按 binding id 解密单个 key（多 key 选择层挑中某个 key 后，只解密它）。
 * 带 userId + active 双条件（纵深防御：不解密别人的/已停用的 key）。
 */
export async function getDecryptedBYOKKeyById(
  userId: string,
  bindingId: string,
): Promise<string | null> {
  const secret = encryptionSecret();
  const result = await db.execute(sql`
    SELECT pgp_sym_decrypt("encryptedKey"::bytea, ${secret}::text) AS key
    FROM "AiKeyBinding"
    WHERE "id" = ${bindingId}
      AND "userId" = ${userId}
      AND "active" = true
    LIMIT 1
  `);
  const rows = result as unknown as Array<{ key: string | null }>;
  return rows[0]?.key ?? null;
}

/** 停用 BYOK（临时禁用而不删除；保留供内部使用/未来 UI）。 */
export async function deactivateBYOKKey(userId: string, provider: string): Promise<void> {
  await db
    .update(aiKeyBindings)
    .set({ active: false, updatedAt: new Date() })
    .where(and(eq(aiKeyBindings.userId, userId), eq(aiKeyBindings.provider, provider)));
}

/**
 * 硬删除单个 BYOK key（用户 UI「撤销/删除」按钮）——按 **binding id** 物理删除整行,含加密
 * key + 历史。撤销即删除（用户诉求 + 隐私：key 不再留存）。
 *
 * 多 key：一个 provider 可有多个 key，故按 id 精确删（不再按 provider 一删一片）。
 * 归属校验：id + userId 双条件——传别人的 id 删不到（deleted=false）。返回 provider/keyHint 供审计。
 */
export async function deleteBYOKKey(
  userId: string,
  bindingId: string,
): Promise<{ deleted: boolean; provider: string | null; keyHint: string | null }> {
  const rows = await db
    .delete(aiKeyBindings)
    .where(and(eq(aiKeyBindings.id, bindingId), eq(aiKeyBindings.userId, userId)))
    .returning({ provider: aiKeyBindings.provider, keyHint: aiKeyBindings.keyHint });
  return {
    deleted: rows.length > 0,
    provider: rows[0]?.provider ?? null,
    keyHint: rows[0]?.keyHint ?? null,
  };
}
