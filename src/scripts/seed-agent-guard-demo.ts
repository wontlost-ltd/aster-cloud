/**
 * Agent 绕过演示播种脚本（aster-api#464 阶段 D，Task 13；仅 local-stack / 演示环境）。
 *
 * 创建：
 *   - Team agent-guard-demo（owner = agd-owner，成员 agd-member）
 *   - 团队策略 pol-agent-guard-demo：源码取自 scripts/agent-guard-demo/policy.aster（模块 demo.billing、入口 decide，
 *     refund_payment → DENY，@id DEMO-REFUND-001）。版本作者为 agd-member，以 APPROVED 落库（团队四眼由 owner 审批，
 *     种子直接写审批结果，与 seed:credit-pilot 同口径），再由 owner 经 setDefaultVersion 设为默认版本——
 *     这一步就是 #464 A2 的挂点：先部署到 aster-api Guard（PUT /api/v1/guard/policy-deployments/{id}）、成功后才提交。
 *   - agd-member 的团队 API key agent-guard-demo-agent（明文仅创建时打印；--rotate-key 吊销旧 key 后重签）
 *
 * 幂等：按 id / key 名有则更新、无则插入。policy.aster 内容变化时追加新版本并设为默认（旧版本保留，链式封印同保存路径）。
 *
 * 环境变量：
 *   DATABASE_URL                     必须
 *   ASTER_API_INTERNAL_URL 等        与 cloud 进程相同的 aster-api 地址与 ASTER_PLAN_GATE_HMAC_KEY（部署与 key 快照经 HMAC 调用）
 *   AGD_SEED_PASSWORD                可选（默认 Aster2026!）
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
import { and, asc, eq, isNull } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { createApiKey, refreshTeamKeySnapshots } from '@/lib/api-keys';
import { assertSeedCompiles } from '@/lib/seed-compile-gate';
import { sealSeedVersionChain } from '@/lib/seed-version-seal';
import { cloudToolchainId } from '@/lib/policy-alias';
import { loadSaveVocabulary } from '@/lib/policy-compile-validator';
import { setDefaultVersion } from '@/services/policy/version-manager';

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

const versionId = (version: number) => `${POLICY_ID}-v${version}`;

async function upsertUser(db: Db, spec: (typeof USERS)[number], passwordHash: string): Promise<void> {
  const values = {
    name: spec.id,
    email: `${spec.id}@stack.test`,
    passwordHash,
    plan: spec.plan,
    priceLockedAt: new Date(),
    legacyTier: null,
    updatedAt: new Date(),
  };
  const existing = await db.query.users.findFirst({ where: eq(schema.users.id, spec.id) });
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
  const values = { name: 'Agent Guard demo', slug: TEAM_ID, ownerId: OWNER_ID, updatedAt: new Date() };
  const existing = await db.query.teams.findFirst({ where: eq(schema.teams.id, TEAM_ID) });
  if (existing) {
    await db.update(schema.teams).set(values).where(eq(schema.teams.id, TEAM_ID));
    return;
  }
  await db.insert(schema.teams).values({ id: TEAM_ID, ...values, createdAt: new Date() });
}

async function upsertTeamMember(db: Db, spec: (typeof USERS)[number]): Promise<void> {
  const id = `${TEAM_ID}-${spec.id}`;
  const existing = await db.query.teamMembers.findFirst({ where: eq(schema.teamMembers.id, id) });
  if (existing) {
    await db.update(schema.teamMembers).set({ role: spec.role }).where(eq(schema.teamMembers.id, id));
    return;
  }
  await db.insert(schema.teamMembers).values({ id, teamId: TEAM_ID, userId: spec.id, role: spec.role, createdAt: new Date() });
}

async function upsertPolicy(db: Db, source: string, version: number): Promise<void> {
  const values = {
    userId: OWNER_ID,
    teamId: TEAM_ID,
    name: 'Agent Guard demo — billing (#464)',
    content: source,
    version,
    isPublic: false,
    deletedAt: null,
    updatedAt: new Date(),
  };
  const existing = await db.query.policies.findFirst({ where: eq(schema.policies.id, POLICY_ID) });
  if (existing) {
    await db.update(schema.policies).set(values).where(eq(schema.policies.id, POLICY_ID));
    return;
  }
  await db.insert(schema.policies).values({ id: POLICY_ID, ...values, createdAt: new Date() });
}

/**
 * 写版本链：已有版本原样保留，最新版本内容与 policy.aster 不同时追加一版。返回应设为默认的版本号。
 * 封印与保存路径同构（链式哈希、5 段 envelope、工具链身份）；新版本以 APPROVED、非默认落库，默认由 setDefaultVersion 切换。
 */
async function upsertVersions(db: Db, source: string): Promise<number> {
  const existing = await db.query.policyVersions.findMany({
    where: eq(schema.policyVersions.policyId, POLICY_ID),
    orderBy: asc(schema.policyVersions.version),
  });
  const contents = existing.map((v) => v.content);
  if (contents.at(-1) !== source) contents.push(source);

  await assertSeedCompiles(source, LOCALE, `${POLICY_ID}@v${contents.length}`);
  const inputs = [];
  for (const content of contents) {
    const { vocabulary, scopesJson } = await loadSaveVocabulary(MEMBER_ID, { source: content, locale: LOCALE });
    if (vocabulary) throw new Error(`作者 ${MEMBER_ID} 有作用域内的领域词汇，种子不做审批冻结，拒绝写库`);
    inputs.push({ content, scopesJson });
  }
  const sealed = sealSeedVersionChain(inputs, { locale: LOCALE, toolchainId: cloudToolchainId() });

  for (const [i, fields] of sealed.entries()) {
    const version = i + 1;
    const row = existing.find((v) => v.version === version);
    if (row) {
      await db.update(schema.policyVersions).set(fields).where(eq(schema.policyVersions.id, row.id));
      continue;
    }
    await db.insert(schema.policyVersions).values({
      id: versionId(version),
      ...fields,
      policyId: POLICY_ID,
      version,
      status: 'APPROVED',
      createdBy: MEMBER_ID,
      isDefault: false,
    });
  }
  return sealed.length;
}

const memberKeyWhere = () =>
  and(
    eq(schema.apiKeys.name, API_KEY_NAME),
    eq(schema.apiKeys.userId, MEMBER_ID),
    eq(schema.apiKeys.teamId, TEAM_ID),
    isNull(schema.apiKeys.revokedAt),
  );

/** 明文 key 只能在创建时拿到一次：已存在且未要求轮换则不重签。返回明文或 undefined。 */
async function ensureMemberKey(db: Db, rotate: boolean): Promise<string | undefined> {
  if (rotate) {
    await db.update(schema.apiKeys).set({ revokedAt: new Date() }).where(memberKeyWhere());
  } else if (await db.query.apiKeys.findFirst({ where: memberKeyWhere() })) {
    console.log(LOG, `API key ${API_KEY_NAME} 已存在，明文不可再取（--rotate-key 吊销后重签）`);
    return undefined;
  }
  try {
    return (await createApiKey(MEMBER_ID, API_KEY_NAME, TEAM_ID)).key;
  } catch (err) {
    // 快照推送依赖 aster-api；失败时行已落库而明文随异常丢失，吊销它，下次重跑才能重新签发。
    await db.update(schema.apiKeys).set({ revokedAt: new Date() }).where(memberKeyWhere());
    throw new Error(`创建 API key 失败（aster-api 可能不可达），已吊销本次插入的 key：${String(err)}`);
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const rotate = process.argv.includes('--rotate-key');
  const source = readFileSync(POLICY_FILE, 'utf8');
  const password = process.env.AGD_SEED_PASSWORD ?? 'Aster2026!';
  const passwordHash = await bcrypt.hash(password, 12);

  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  const db = drizzle(sql, { schema });
  try {
    console.log(LOG, '用户 / 团队', USERS.map((u) => u.id).join(' / '), TEAM_ID);
    for (const spec of USERS) await upsertUser(db, spec, passwordHash);
    await upsertTeam(db);
    for (const spec of USERS) await upsertTeamMember(db, spec);

    const version = await upsertVersions(db, source);
    await upsertPolicy(db, source, version);

    // #464 A2 挂点：先部署到 aster-api Guard，成功后才提交默认版本（失败抛 GuardDeployError，默认版本不变）。
    console.log(LOG, `设 ${POLICY_ID} v${version} 为默认版本并部署到 aster-api Guard`);
    await setDefaultVersion({ policyId: POLICY_ID, version, userId: OWNER_ID });
    const deployment = await db.query.guardPolicyDeployments.findFirst({
      where: eq(schema.guardPolicyDeployments.policyId, POLICY_ID),
    });
    console.log(LOG, 'Guard 部署状态', JSON.stringify(deployment));

    const key = await ensureMemberKey(db, rotate);
    console.log(LOG, '已刷新团队 key 快照', await refreshTeamKeySnapshots(TEAM_ID));

    console.log(LOG, '完成；演示环境变量：');
    console.log(`  DEMO_TENANT_ID=${TEAM_ID}`);
    if (key) console.log(`  DEMO_API_KEY=${key}   # 仅此一次`);
    console.log(`  账号 ${USERS.map((u) => u.id).join(' / ')}@stack.test，密码 ${password}`);
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
