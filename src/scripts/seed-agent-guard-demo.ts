/**
 * Agent 绕过演示播种脚本（aster-api#464 阶段 D，Task 13；仅 local-stack / 演示环境）。
 *
 * 创建：
 *   - Team agent-guard-demo（owner = agd-owner，成员 agd-member）
 *   - 团队策略 pol-agent-guard-demo：源码取自 scripts/agent-guard-demo/policy.aster（模块 demo.billing、入口 decide，
 *     refund_payment → DENY，@id DEMO-REFUND-001）。版本走与界面相同的服务层路径：agd-member 保存（createVersion）
 *     并提交审批 → agd-owner 审批（团队四眼）→ agd-owner 设为默认版本（setDefaultVersion）。最后一步就是 #464 A2 的挂点：
 *     先部署到 aster-api Guard（PUT /api/v1/guard/policy-deployments/{id}）、成功后才提交默认版本。
 *   - agd-member 的团队 API key agent-guard-demo-agent（明文仅创建时打印；--rotate-key 吊销旧 key 后重签）
 *
 * 只写本地库：DATABASE_URL 的主机须为 localhost / 127.0.0.1 / ::1，否则拒绝运行（容器内的本地栈主机名等确属演示库时
 * 设 AGD_SEED_ALLOW_REMOTE=1）。已有同 id 的用户只更新套餐、不动邮箱与密码；同 id 的团队 / 策略属于别人时报错，不接管。
 *
 * 幂等：按 id / key 名有则更新、无则插入；已有版本从不改写。最新版本内容与 policy.aster 相同则沿用（只补完未走完的
 * 提交 / 审批），不同则经保存路径追加新版本（链式封印由 createVersion 负责）。
 *
 * 环境变量：
 *   DATABASE_URL                     必须
 *   ASTER_API_INTERNAL_URL 等        与 cloud 进程相同的 aster-api 地址与 ASTER_PLAN_GATE_HMAC_KEY（部署与 key 快照经 HMAC 调用）
 *   AGD_SEED_PASSWORD                可选（默认 Aster2026!，只用于新建的演示账号）
 *   AGD_SEED_ALLOW_REMOTE=1          可选：允许非本机主机名的 DATABASE_URL（仅限确属演示环境的库）
 *
 * 用法：pnpm seed:agent-guard-demo [--rotate-key]
 * 之后：BASE_API=<aster-api> DEMO_API_KEY=<打印的 key> DEMO_TENANT_ID=agent-guard-demo pnpm demo:agent-guard
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, desc, eq, isNull } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { createApiKey, refreshTeamKeySnapshots, revokeApiKey } from '@/lib/api-keys';
import { assertSeedCompiles } from '@/lib/seed-compile-gate';
import { loadSaveVocabulary } from '@/lib/policy-compile-validator';
import { approveVersion, createVersion, setDefaultVersion, submitForApproval } from '@/services/policy/version-manager';

type Db = ReturnType<typeof drizzle<typeof schema>>;

const LOG = '[seed-agent-guard-demo]';
const LOCALE = 'en-US';
const TEAM_ID = 'agent-guard-demo';
const OWNER_ID = 'agd-owner';
const MEMBER_ID = 'agd-member';
const POLICY_ID = 'pol-agent-guard-demo';
const API_KEY_NAME = 'agent-guard-demo-agent';
const POLICY_FILE = process.env.AGD_POLICY_FILE ?? join(process.cwd(), 'scripts', 'agent-guard-demo', 'policy.aster');

const USERS = [
  { id: OWNER_ID, plan: 'team' as const, role: 'owner' as const },
  { id: MEMBER_ID, plan: 'pro' as const, role: 'member' as const },
];

const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** 种子直接写库：默认只允许本机数据库，防止误连共享 / 生产库。 */
function assertDemoDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (LOCAL_DB_HOSTS.has(host)) return;
  if (process.env.AGD_SEED_ALLOW_REMOTE === '1') {
    console.warn(LOG, `DATABASE_URL 主机为 ${host}（AGD_SEED_ALLOW_REMOTE=1 放行）`);
    return;
  }
  throw new Error(`DATABASE_URL 主机 ${host} 不是本机；演示种子只写本地库（确属演示库时设 AGD_SEED_ALLOW_REMOTE=1）`);
}

/** 最新版本内容相同时可沿用的状态（其余如 DEPRECATED / ARCHIVED 追加新版本）。 */
const REUSABLE = new Set(['DRAFT', 'REJECTED', 'PENDING_APPROVAL', 'APPROVED']);

/**
 * 新建演示账号；同 id 已存在时只更新套餐（不动邮箱与密码）。返回是否新建。
 * 已有账号的邮箱不是本种子建的 `<id>@stack.test` 时报错：那不是演示账号，不改它的套餐。
 */
async function upsertUser(db: Db, spec: (typeof USERS)[number], passwordHash: string): Promise<boolean> {
  const email = `${spec.id}@stack.test`;
  const existing = await db.query.users.findFirst({ where: eq(schema.users.id, spec.id) });
  if (existing) {
    if (existing.email !== email) throw new Error(`用户 ${spec.id} 已存在且不是演示账号（邮箱 ${existing.email}），拒绝改动`);
    await db.update(schema.users).set({ plan: spec.plan, updatedAt: new Date() }).where(eq(schema.users.id, spec.id));
    return false;
  }
  await db.insert(schema.users).values({
    id: spec.id,
    name: spec.id,
    email,
    passwordHash,
    plan: spec.plan,
    priceLockedAt: new Date(),
    emailVerified: new Date(),
    failedLoginAttempts: 0,
    lockoutCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return true;
}

/** 同 id 的团队已存在且属主不是 agd-owner 时报错，不接管别人的团队。 */
async function upsertTeam(db: Db): Promise<void> {
  const existing = await db.query.teams.findFirst({ where: eq(schema.teams.id, TEAM_ID) });
  if (existing) {
    if (existing.ownerId !== OWNER_ID) throw new Error(`团队 ${TEAM_ID} 已存在且属主为 ${existing.ownerId}，拒绝接管`);
    return;
  }
  await db.insert(schema.teams).values({
    id: TEAM_ID,
    name: 'Agent Guard demo',
    slug: TEAM_ID,
    ownerId: OWNER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function upsertTeamMember(db: Db, spec: (typeof USERS)[number]): Promise<void> {
  const id = `${TEAM_ID}-${spec.id}`;
  const existing = await db.query.teamMembers.findFirst({ where: eq(schema.teamMembers.id, id) });
  if (existing) {
    if (existing.teamId !== TEAM_ID || existing.userId !== spec.id) {
      throw new Error(`团队成员记录 ${id} 已被占用（${existing.teamId} / ${existing.userId}），拒绝改动`);
    }
    await db.update(schema.teamMembers).set({ role: spec.role }).where(eq(schema.teamMembers.id, id));
    return;
  }
  await db.insert(schema.teamMembers).values({ id, teamId: TEAM_ID, userId: spec.id, role: spec.role, createdAt: new Date() });
}

/** 建策略行（团队策略，owner 为属主）；已存在则只核对归属，内容与版本号等默认版本部署成功后再回填。 */
async function ensurePolicy(db: Db, source: string): Promise<void> {
  const existing = await db.query.policies.findFirst({ where: eq(schema.policies.id, POLICY_ID) });
  if (existing) {
    if (existing.teamId !== TEAM_ID || existing.userId !== OWNER_ID) {
      throw new Error(`策略 ${POLICY_ID} 已存在且不是本种子建的演示策略（${existing.teamId} / ${existing.userId}），拒绝改写`);
    }
    if (existing.deletedAt) throw new Error(`策略 ${POLICY_ID} 在回收站中，先在界面恢复再重跑`);
    return;
  }
  await db.insert(schema.policies).values({
    id: POLICY_ID,
    userId: OWNER_ID,
    teamId: TEAM_ID,
    name: 'Agent Guard demo — billing (#464)',
    content: source,
    version: 1,
    isPublic: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/**
 * 让与 policy.aster 相同内容的版本处于 APPROVED：沿用最新版本或经保存路径新建，再补完提交（作者）与审批（owner）。
 * 返回该版本号。已有版本只经服务层推进状态，从不改写其内容与封印。
 */
async function ensureApprovedVersion(db: Db, source: string): Promise<number> {
  const latest = await db.query.policyVersions.findFirst({
    where: eq(schema.policyVersions.policyId, POLICY_ID),
    orderBy: desc(schema.policyVersions.version),
  });
  let version: number;
  let status: string;
  if (latest && latest.content === source && REUSABLE.has(latest.status)) {
    ({ version, status } = latest);
  } else {
    await assertSeedCompiles(source, LOCALE, `${POLICY_ID}@new`);
    const { vocabulary, scopesJson } = await loadSaveVocabulary(MEMBER_ID, { source, locale: LOCALE });
    if (vocabulary) throw new Error(`作者 ${MEMBER_ID} 有作用域内的领域词汇，演示策略不使用词汇，拒绝写库`);
    ({ version } = await createVersion({ policyId: POLICY_ID, source, createdBy: MEMBER_ID, locale: LOCALE, scopesJson }));
    status = 'DRAFT';
    console.log(LOG, `已保存新版本 v${version}`);
  }
  if (status === 'DRAFT' || status === 'REJECTED') {
    await submitForApproval({ policyId: POLICY_ID, version, userId: MEMBER_ID, releaseNote: 'Agent Guard demo (#464)' });
    status = 'PENDING_APPROVAL';
  }
  if (status === 'PENDING_APPROVAL') {
    await approveVersion({ policyId: POLICY_ID, version, approverId: OWNER_ID, decision: 'APPROVED', comment: 'demo seed' });
  }
  return version;
}

const memberKeyWhere = () =>
  and(
    eq(schema.apiKeys.name, API_KEY_NAME),
    eq(schema.apiKeys.userId, MEMBER_ID),
    eq(schema.apiKeys.teamId, TEAM_ID),
    isNull(schema.apiKeys.revokedAt),
  );

/** 经应用的吊销函数吊销成员的演示 key：同时通知 aster-api，旧 key 立即失效而不是等缓存过期。 */
async function revokeMemberKeys(db: Db): Promise<number> {
  const keys = await db.query.apiKeys.findMany({ where: memberKeyWhere(), columns: { id: true } });
  for (const { id } of keys) await revokeApiKey(MEMBER_ID, id);
  return keys.length;
}

/** 明文 key 只能在创建时拿到一次：已存在且未要求轮换则不重签。返回明文或 undefined。 */
async function ensureMemberKey(db: Db, rotate: boolean): Promise<string | undefined> {
  if (rotate) {
    console.log(LOG, `已吊销旧 key ${await revokeMemberKeys(db)} 把`);
  } else if (await db.query.apiKeys.findFirst({ where: memberKeyWhere() })) {
    console.log(LOG, `API key ${API_KEY_NAME} 已存在，明文不可再取（--rotate-key 吊销后重签）`);
    return undefined;
  }
  try {
    return (await createApiKey(MEMBER_ID, API_KEY_NAME, TEAM_ID)).key;
  } catch (err) {
    // 快照推送依赖 aster-api；失败时行已落库而明文随异常丢失，吊销它，下次重跑才能重新签发。
    await revokeMemberKeys(db);
    throw new Error(`创建 API key 失败（aster-api 可能不可达），已吊销本次插入的 key：${String(err)}`);
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  assertDemoDatabase(process.env.DATABASE_URL);
  const rotate = process.argv.includes('--rotate-key');
  const source = readFileSync(POLICY_FILE, 'utf8');
  const password = process.env.AGD_SEED_PASSWORD ?? 'Aster2026!';
  const passwordHash = await bcrypt.hash(password, 12);

  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  const db = drizzle(sql, { schema });
  try {
    console.log(LOG, '用户 / 团队', USERS.map((u) => u.id).join(' / '), TEAM_ID);
    const created: string[] = [];
    for (const spec of USERS) if (await upsertUser(db, spec, passwordHash)) created.push(spec.id);
    await upsertTeam(db);
    for (const spec of USERS) await upsertTeamMember(db, spec);

    // 策略行先于版本存在（保存路径要求）。任一步失败时策略行保持原样，重跑从最新版本的状态接着走。
    await ensurePolicy(db, source);
    const version = await ensureApprovedVersion(db, source);

    // #464 A2 挂点：先部署到 aster-api Guard，成功后才提交默认版本（失败抛 GuardDeployError，默认版本不变）。
    console.log(LOG, `设 ${POLICY_ID} v${version} 为默认版本并部署到 aster-api Guard`);
    await setDefaultVersion({ policyId: POLICY_ID, version, userId: OWNER_ID });
    await db
      .update(schema.policies)
      .set({ content: source, version, updatedAt: new Date() })
      .where(eq(schema.policies.id, POLICY_ID));
    const deployment = await db.query.guardPolicyDeployments.findFirst({
      where: eq(schema.guardPolicyDeployments.policyId, POLICY_ID),
    });
    console.log(LOG, 'Guard 部署状态', JSON.stringify(deployment));

    const key = await ensureMemberKey(db, rotate);
    console.log(LOG, '已刷新团队 key 快照', await refreshTeamKeySnapshots(TEAM_ID));

    console.log(LOG, '完成；演示环境变量：');
    console.log(`  DEMO_TENANT_ID=${TEAM_ID}`);
    if (key) console.log(`  DEMO_API_KEY=${key}   # 仅此一次`);
    if (created.length > 0) console.log(`  新建账号 ${created.join(' / ')}（邮箱 <id>@stack.test），密码 ${password}`);
  } finally {
    await sql.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(LOG, '失败', err);
    process.exit(1);
  });
