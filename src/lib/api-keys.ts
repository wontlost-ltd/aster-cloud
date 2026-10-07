import { randomBytes, createHash } from 'crypto';
import { db, apiKeys } from '@/lib/prisma';
import { eq, desc, isNull, and } from 'drizzle-orm';
import { resolveApiKeyIdentity, type ApiKeyIdentity } from '@/lib/api-key-identity';
import { pushApiKeySnapshot } from '@/lib/snapshot-pusher';
import { invalidateApiKeyCache } from '@/lib/plan-gate-client';
import { hasFeatureAccess } from '@/lib/usage';

// Generate a new API key
export function generateApiKey(): { key: string; hash: string; prefix: string } {
  // Generate 32 random bytes -> 64 hex chars
  const rawKey = randomBytes(32).toString('hex');

  // Key format: ak_<prefix>_<rest>
  const prefix = rawKey.substring(0, 8);
  const key = `ak_${rawKey}`;

  // Hash the key for storage
  const hash = hashApiKey(key);

  return { key, hash, prefix };
}

// Hash an API key for storage
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

// 创建 API key；teamId 非空即团队 key（调用方须先校验成员资格与 owner 套餐）
export async function createApiKey(userId: string, name: string, teamId: string | null = null): Promise<{
  id: string;
  key: string;
  prefix: string;
  name: string;
  teamId: string | null;
  createdAt: Date;
}> {
  const { key, hash, prefix } = generateApiKey();

  const [apiKey] = await db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    userId,
    teamId,
    name,
    key: hash,
    prefix,
  }).returning();

  // 让 aster-api 立刻拿到身份快照，而不是等 1 h TTL 或下一次 verify（ADR 0015 §5）
  await pushApiKeySnapshot(hash);

  // 明文 key 只在此返回一次，之后无法再取回
  return {
    id: apiKey.id,
    key,
    prefix: apiKey.prefix,
    name: apiKey.name,
    teamId: apiKey.teamId ?? null,
    createdAt: apiKey.createdAt,
  };
}

type InvalidReason = Extract<ApiKeyIdentity, { valid: false }>['reason'];

const INVALID_KEY_MESSAGES: Record<InvalidReason, string> = {
  not_found: 'Invalid API key',
  revoked: 'API key has been revoked',
  expired: 'API key has expired',
  orphan_key: 'Invalid API key',
  team_not_found: 'API key team no longer exists',
  membership_revoked: 'API key holder is no longer a member of the team',
};

// 校验 API key：身份只经由解析器获得，与 verify 路由 / snapshot 推送同口径（ADR 0015 §2）
export async function validateApiKey(key: string): Promise<{
  valid: boolean;
  userId?: string;
  apiKeyId?: string;
  teamId?: string | null;
  error?: string;
}> {
  if (!key || !key.startsWith('ak_')) {
    return { valid: false, error: 'Invalid API key format' };
  }

  const identity = await resolveApiKeyIdentity(hashApiKey(key));
  if (!identity.valid) {
    return { valid: false, error: INVALID_KEY_MESSAGES[identity.reason] };
  }

  // 套餐门槛看配额 owner（团队 key 即 team owner），与 POST /api/api-keys 同口径；
  // 试用过期的自动降级也在 hasFeatureAccess 内完成
  if (!(await hasFeatureAccess(identity.quotaOwnerId, 'apiAccess'))) {
    return { valid: false, error: 'API access requires a Pro or Team subscription' };
  }

  await db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, identity.apiKeyId));

  return {
    valid: true,
    userId: identity.userId,
    apiKeyId: identity.apiKeyId,
    teamId: identity.teamId,
  };
}

// 列出用户本人持有的活跃 key（不含 hash），团队 key 附带团队名
export async function listApiKeys(userId: string) {
  const keys = await db.query.apiKeys.findMany({
    where: and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)),
    columns: {
      id: true,
      name: true,
      prefix: true,
      teamId: true,
      lastUsedAt: true,
      expiresAt: true,
      createdAt: true,
    },
    with: { team: { columns: { name: true } } },
    orderBy: [desc(apiKeys.createdAt)],
  });

  return keys.map(({ team, ...k }) => ({
    ...k,
    teamId: k.teamId ?? null,
    teamName: team?.name ?? null,
  }));
}

// 吊销本人的一把 key；成功后通知 aster-api，让它立即拒绝该 key
export async function revokeApiKey(userId: string, keyId: string): Promise<boolean> {
  const result = await db.update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, keyId),
        eq(apiKeys.userId, userId),
        isNull(apiKeys.revokedAt)
      )
    )
    .returning({ key: apiKeys.key, userId: apiKeys.userId });

  if (result.length === 0) return false;
  await notifyKeysChanged(result);
  return true;
}

// 团队范围内活跃 key 的过滤条件；给出 userId 时只取该成员的 key。
// 只有省略 userId 才表示整队：空串也按成员过滤，防止调用方的空 id 吊销全队 key
function activeTeamKeysWhere(teamId: string, userId?: string) {
  const conds = [eq(apiKeys.teamId, teamId), isNull(apiKeys.revokedAt)];
  if (userId !== undefined) conds.push(eq(apiKeys.userId, userId));
  return and(...conds);
}

// 吊销团队（或团队内某成员）的全部活跃 key，返回吊销条数。用于团队删除 / 成员移出
export async function revokeTeamKeys(teamId: string, userId?: string): Promise<number> {
  const result = await db.update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(activeTeamKeysWhere(teamId, userId))
    .returning({ key: apiKeys.key, userId: apiKeys.userId });

  await notifyKeysChanged(result);
  return result.length;
}

// 重推团队（或团队内某成员）全部活跃 key 的快照，返回条数。用于角色变更 / 转让 owner 等不吊销的身份变化
export async function refreshTeamKeySnapshots(teamId: string, userId?: string): Promise<number> {
  const rows = await db.query.apiKeys.findMany({
    where: activeTeamKeysWhere(teamId, userId),
    columns: { key: true, userId: true },
  });

  await notifyKeysChanged(rows);
  return rows.length;
}

// 单批并发推送的 key 数：aster-api 挂起时耗时按批数（而非 key 数）累加 2 s 超时，又不一次打出过多请求
const NOTIFY_CHUNK_SIZE = 10;

/**
 * key 身份变化后通知 aster-api：分批并发推最新快照（吊销后即为无效快照），
 * 再按持有者去重、并发失效 verify 缓存。两个 helper 都 fail-open（从不抛错），
 * 所以 Promise.all 不会因单个失败而中断，失败只记日志、不影响 DB 结果。
 */
async function notifyKeysChanged(rows: Array<{ key: string; userId: string }>): Promise<void> {
  for (let i = 0; i < rows.length; i += NOTIFY_CHUNK_SIZE) {
    await Promise.all(rows.slice(i, i + NOTIFY_CHUNK_SIZE).map((row) => pushApiKeySnapshot(row.key)));
  }
  const holderIds = [...new Set(rows.map((row) => row.userId))];
  await Promise.all(holderIds.map((holderId) => invalidateApiKeyCache(holderId)));
}

// API 认证结果类型
export type ApiAuthResult =
  | {
      success: true;
      userId: string;
      apiKeyId: string;
      teamId: string | null;
    }
  | {
      success: false;
      error: string;
      status: number;
    };

// 从请求中验证 API Key 的辅助函数
export async function authenticateApiRequest(req: Request): Promise<ApiAuthResult> {
  const authHeader = req.headers.get('authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return {
      success: false,
      error: 'Missing or invalid Authorization header',
      status: 401,
    };
  }

  const apiKey = authHeader.substring(7);
  const validation = await validateApiKey(apiKey);

  if (!validation.valid || !validation.userId) {
    return {
      success: false,
      error: validation.error || 'Invalid API key',
      status: 401,
    };
  }

  return {
    success: true,
    userId: validation.userId,
    apiKeyId: validation.apiKeyId!,
    teamId: validation.teamId ?? null,
  };
}
