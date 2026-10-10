/**
 * 信贷试点租户播种脚本（ADR 0044 §5）
 *
 * 创建：
 *   - Team credit-pilot（owner=cp-owner）
 *   - User cp-owner(team) / cp-officer(pro, 业务角色 Credit Officer) / cp-analyst(pro)
 *   - Policy pol-credit-pilot 与三条已批准版本：v1（阈值 50000）与 v2（阈值 80000）作 What-If 对比；
 *     v3 以语法糖重写 v1 并声明 eu-ai-act-high-risk 档案（ADR 0046 §6），为在线默认版本
 *   - cp-owner 的团队 API key credit-pilot-owner（明文仅首次创建时打印）；吊销旧的 credit-pilot-analyst key
 *     由属主经 API key 执行：What-If / 日志 / 导出均按策略属主限定（ADR 0034 §4.3），
 *     团队成员执行的记录当前无法被 What-If 回放；cp-analyst 仅作普通成员
 *
 * 幂等：按 id / key 名查有则更新、无则插入；多次运行不会重复创建
 *
 * 环境变量：
 *   DATABASE_URL       必须
 *   CP_SEED_PASSWORD   可选（默认 Aster2026!）
 *
 * 用法：pnpm seed:credit-pilot
 */

import 'dotenv/config';
import { createHash } from 'crypto';
import bcrypt from 'bcryptjs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { creditPilotSource, creditPilotSugarSource, CREDIT_PILOT } from '@/config/credit-pilot-source';
import { createApiKey, refreshTeamKeySnapshots } from '@/lib/api-keys';

type Db = ReturnType<typeof drizzle<typeof schema>>;

const LOG = '[seed-credit-pilot]';
const TOOLCHAIN_ID = 'abi=1.0;core=1.0.30;validator=1;build=dev';
const API_KEY_NAME = 'credit-pilot-owner';
const LEGACY_KEY_NAME = 'credit-pilot-analyst';

interface UserSpec {
  id: string;
  plan: 'team' | 'pro';
  businessRoles: string[];
}

const USERS: UserSpec[] = [
  { id: CREDIT_PILOT.ownerId, plan: 'team', businessRoles: [] },
  { id: CREDIT_PILOT.officerId, plan: 'pro', businessRoles: [CREDIT_PILOT.role] },
  { id: CREDIT_PILOT.analystId, plan: 'pro', businessRoles: [] },
];

// v1→v2 仅作 What-If 对比；v3 与 v1 结论相同，为在线默认版本。
// 按序写入：先把 v1 的默认标记清掉，再置 v3 为默认，任一时刻至多一个默认版本。
const LIVE_CONTENT = creditPilotSugarSource('en');
const LIVE_VERSION = 3;
const VERSIONS = [
  { id: CREDIT_PILOT.versionIds[0], version: 1, content: creditPilotSource('en', 50000), isDefault: false },
  { id: CREDIT_PILOT.versionIds[1], version: 2, content: creditPilotSource('en', 80000), isDefault: false },
  { id: CREDIT_PILOT.versionIds[2], version: LIVE_VERSION, content: LIVE_CONTENT, isDefault: true },
];

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function upsertUser(db: Db, spec: UserSpec, passwordHash: string): Promise<void> {
  const existing = await db.query.users.findFirst({ where: eq(schema.users.id, spec.id) });
  const values = {
    name: spec.id,
    email: `${spec.id}@stack.test`,
    passwordHash,
    plan: spec.plan,
    priceLockedAt: new Date(),
    legacyTier: null,
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(schema.users).set(values).where(eq(schema.users.id, spec.id));
    return;
  }
  await db.insert(schema.users).values({
    id: spec.id,
    ...values,
    emailVerified: new Date(),
    failedLoginAttempts: 0,
    lockoutCount: 0,
    createdAt: new Date(),
  });
}

async function upsertTeam(db: Db): Promise<void> {
  const existing = await db.query.teams.findFirst({ where: eq(schema.teams.id, CREDIT_PILOT.teamId) });
  const values = {
    name: CREDIT_PILOT.teamId,
    slug: CREDIT_PILOT.teamId,
    ownerId: CREDIT_PILOT.ownerId,
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(schema.teams).set(values).where(eq(schema.teams.id, CREDIT_PILOT.teamId));
    return;
  }
  await db.insert(schema.teams).values({ id: CREDIT_PILOT.teamId, ...values, createdAt: new Date() });
}

async function upsertTeamMember(db: Db, spec: UserSpec): Promise<void> {
  const memberId = `${CREDIT_PILOT.teamId}-${spec.id}`;
  const existing = await db.query.teamMembers.findFirst({ where: eq(schema.teamMembers.id, memberId) });
  const values = {
    role: spec.id === CREDIT_PILOT.ownerId ? ('owner' as const) : ('member' as const),
    businessRoles: spec.businessRoles,
  };
  if (existing) {
    await db.update(schema.teamMembers).set(values).where(eq(schema.teamMembers.id, memberId));
    return;
  }
  await db.insert(schema.teamMembers).values({
    id: memberId,
    teamId: CREDIT_PILOT.teamId,
    userId: spec.id,
    ...values,
    createdAt: new Date(),
  });
}

async function upsertPolicy(db: Db): Promise<void> {
  const existing = await db.query.policies.findFirst({ where: eq(schema.policies.id, CREDIT_PILOT.policyId) });
  const values = {
    userId: CREDIT_PILOT.ownerId,
    teamId: CREDIT_PILOT.teamId,
    name: 'Credit pilot (ADR 0044)',
    content: LIVE_CONTENT,
    version: LIVE_VERSION,
    isPublic: false,
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(schema.policies).set(values).where(eq(schema.policies.id, CREDIT_PILOT.policyId));
    return;
  }
  await db.insert(schema.policies).values({ id: CREDIT_PILOT.policyId, ...values, createdAt: new Date() });
}

async function upsertVersion(db: Db, spec: (typeof VERSIONS)[number]): Promise<void> {
  const existing = await db.query.policyVersions.findFirst({ where: eq(schema.policyVersions.id, spec.id) });
  const values = {
    policyId: CREDIT_PILOT.policyId,
    version: spec.version,
    content: spec.content,
    sourceHash: sha256(spec.content),
    status: 'APPROVED' as const,
    createdBy: CREDIT_PILOT.ownerId,
    isDefault: spec.isDefault,
    sourceToolchainId: TOOLCHAIN_ID,
  };
  if (existing) {
    await db.update(schema.policyVersions).set(values).where(eq(schema.policyVersions.id, spec.id));
    return;
  }
  await db.insert(schema.policyVersions).values({ id: spec.id, ...values });
}

// 属主当前有效的试点 key（同名、同用户、同团队、未吊销）。
const ownerKeyWhere = () =>
  and(
    eq(schema.apiKeys.name, API_KEY_NAME),
    eq(schema.apiKeys.userId, CREDIT_PILOT.ownerId),
    eq(schema.apiKeys.teamId, CREDIT_PILOT.teamId),
    isNull(schema.apiKeys.revokedAt),
  );

// 明文 key 只能在创建时拿到一次；已存在则不重复创建。
async function ensureOwnerKey(db: Db): Promise<void> {
  const existing = await db.query.apiKeys.findFirst({
    where: ownerKeyWhere(),
  });
  if (existing) {
    console.log(LOG, `API key ${API_KEY_NAME} 已存在，明文不可再取`);
    return;
  }
  try {
    const created = await createApiKey(CREDIT_PILOT.ownerId, API_KEY_NAME, CREDIT_PILOT.teamId);
    console.log(LOG, `API key ${API_KEY_NAME} 明文（仅此一次）:`, created.key);
  } catch (err) {
    // 快照推送依赖 aster-api；推送失败时行已落库而明文随异常丢失，吊销它，下次重跑才能重新签发。
    await db.update(schema.apiKeys).set({ revokedAt: new Date() }).where(ownerKeyWhere());
    console.warn(LOG, '创建 API key 失败（aster-api 可能不可达），已吊销本次插入的 key；请在 aster-api 就绪后重跑 seed', err);
  }
}

// 旧版播种为分析员建的 key 已不再使用；吊销未吊销者，重复运行无副作用。
async function revokeLegacyKey(db: Db): Promise<void> {
  const revoked = await db
    .update(schema.apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.apiKeys.name, LEGACY_KEY_NAME),
        eq(schema.apiKeys.teamId, CREDIT_PILOT.teamId),
        isNull(schema.apiKeys.revokedAt),
      ),
    )
    .returning({ id: schema.apiKeys.id });
  if (revoked.length > 0) console.log(LOG, `已吊销旧 API key ${LEGACY_KEY_NAME}`, revoked.length);
}

async function refreshSnapshots(): Promise<void> {
  try {
    const count = await refreshTeamKeySnapshots(CREDIT_PILOT.teamId);
    console.log(LOG, '已刷新团队 key 快照', count);
  } catch (err) {
    console.warn(LOG, '刷新团队 key 快照失败（aster-api 可能不可达），继续', err);
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const password = process.env.CP_SEED_PASSWORD ?? 'Aster2026!';
  const passwordHash = await bcrypt.hash(password, 12);

  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  const db = drizzle(sql, { schema });

  console.log(LOG, '创建用户', USERS.map((u) => u.id).join(' / '));
  for (const spec of USERS) {
    await upsertUser(db, spec, passwordHash);
  }

  console.log(LOG, '创建 Team', CREDIT_PILOT.teamId);
  await upsertTeam(db);
  for (const spec of USERS) {
    await upsertTeamMember(db, spec);
  }

  console.log(LOG, '创建策略', CREDIT_PILOT.policyId, '及版本', CREDIT_PILOT.versionIds.join(' / '));
  await upsertPolicy(db);
  for (const spec of VERSIONS) {
    await upsertVersion(db, spec);
  }

  await revokeLegacyKey(db);
  await ensureOwnerKey(db);
  await refreshSnapshots();

  await sql.end();
  console.log(LOG, '完成');
  console.log(`  账号 ${USERS.map((u) => u.id).join(' / ')}@stack.test`);
  console.log(`  密码 ${password}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(LOG, '失败', err);
    process.exit(1);
  });
