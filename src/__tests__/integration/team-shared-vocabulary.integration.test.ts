// 团队共享领域词汇（#672 / ADR 0017），真实 Postgres + 真实路由处理器。
//
// 夹具：Pro 团队 T（owner 为 Pro，admin / member / viewer 为 Free），团队外用户 outsider（Free，自己有团队 T2）。
// 覆盖：Free 成员可在 Pro 团队新增团队词条、额度按团队 owner 计、viewer 只读、member 只能改自己创建的、
// 离队后不可见不可用、跨团队不可见；团队策略的保存编译 / 审批冻结使用「团队 + 作者」词汇且团队优先，
// 个人策略不受影响。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts team-shared-vocabulary

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';

const current = vi.hoisted(() => ({ userId: null as string | null }));
const quota = vi.hoisted(() => ({ cap: null as number | null, holders: [] as string[] }));
const sessionOf = () => (current.userId ? { user: { id: current.userId } } : null);

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ getSession: vi.fn(async () => sessionOf()), auth: vi.fn(async () => sessionOf()) }));
vi.mock('@/lib/cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cache')>()),
  invalidatePolicyCache: vi.fn(async () => undefined),
}));
vi.mock('@/lib/metrics/aha-detection', () => ({ recordAhaMomentIfFirst: vi.fn(async () => false) }));
// 额度走真实套餐判定（Free 无自定义词汇、Pro 有）；cap 只把已允许的额度压小，便于测上限。holders 记录按谁的套餐判定。
vi.mock('@/lib/usage', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/usage')>();
  return {
    ...real,
    getLexiconQuota: vi.fn(async (userId: string) => {
      quota.holders.push(userId);
      const q = await real.getLexiconQuota(userId);
      return quota.cap === null || !q.allowed ? q : { ...q, maxTerms: quota.cap };
    }),
  };
});

import { createDb } from '@/db';
import {
  auditLogs,
  domainTerms,
  policies,
  policyApprovals,
  policyVersions,
  securityEvents,
  teamMembers,
  teams,
  userDomainTerms,
  users,
  userVocabularySnapshots,
} from '@/lib/prisma';
import * as termsRoute from '@/app/api/v1/domain-vocabularies/terms/route';
import * as termRoute from '@/app/api/v1/domain-vocabularies/terms/[id]/route';
import * as restoreRoute from '@/app/api/v1/domain-vocabularies/terms/[id]/restore/route';
import * as versionRoute from '@/app/api/v1/domain-vocabularies/version/route';
import { loadSaveVocabulary } from '@/lib/policy-compile-validator';
import { loadVocabularyForExecution, type SnapshotRef } from '@/lib/domain-vocabulary-snapshot';
import { approveVersion } from '@/services/policy/version-manager';

const P = 'it-tsv';
const TEAM = `${P}-team`;
const TEAM2 = `${P}-team2`;
const U = {
  owner: `${P}-owner`,
  admin: `${P}-admin`,
  member: `${P}-member`,
  viewer: `${P}-viewer`,
  outsider: `${P}-outsider`,
} as const;
type Actor = keyof typeof U;
const USER_IDS = Object.values(U);
const TEAM_POLICY = `${P}-pol-team`;
const DOMAIN = 'tsv';

const SOURCE = `Modul tsv.vocab.

Definiere Fahrer hat alter als Ganzzahl.

Regel bewerten gegeben person als Fahrer liefert Ganzzahl:
  wenn person.alter mindestens 18:
    gib zurück 42.
  gib zurück 0.
`;
const POLICY_CTX = { source: SOURCE, locale: 'de-DE' };

type Db = ReturnType<typeof createDb>;
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

const BASE = 'http://localhost/api/v1/domain-vocabularies';

function as(actor: Actor): void {
  current.userId = U[actor];
}

function url(path: string, teamId?: string): string {
  return `${BASE}${path}${teamId ? `${path.includes('?') ? '&' : '?'}teamId=${teamId}` : ''}`;
}

const struct = (canonical: string, localized: string) => ({ domain: DOMAIN, locale: 'de', kind: 'struct', canonical, localized });

async function addTerm(actor: Actor, body: object, teamId?: string) {
  as(actor);
  const res = await termsRoute.POST(new Request(url('/terms', teamId), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

async function listTerms(actor: Actor, teamId?: string) {
  as(actor);
  const res = await termsRoute.GET(new Request(url('/terms?pageSize=200', teamId)));
  return { status: res.status, body: await res.json() };
}

async function patchTerm(actor: Actor, linkId: string, body: object, teamId?: string) {
  as(actor);
  const res = await termRoute.PATCH(
    new Request(url(`/terms/${linkId}`, teamId), {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: linkId }) },
  );
  return { status: res.status, body: await res.json() };
}

async function deleteTerm(actor: Actor, linkId: string, teamId?: string) {
  as(actor);
  const res = await termRoute.DELETE(new Request(url(`/terms/${linkId}`, teamId), { method: 'DELETE' }), {
    params: Promise.resolve({ id: linkId }),
  });
  return { status: res.status, body: await res.json() };
}

async function restoreTerm(actor: Actor, linkId: string, teamId?: string) {
  as(actor);
  const res = await restoreRoute.POST(new Request(url(`/terms/${linkId}/restore`, teamId), { method: 'POST' }), {
    params: Promise.resolve({ id: linkId }),
  });
  return { status: res.status, body: await res.json() };
}

async function teamVersion(actor: Actor, teamId: string) {
  as(actor);
  const res = await versionRoute.GET(new Request(url('/version', teamId)));
  return { status: res.status, body: await res.json() };
}

function localizedOf(items: Array<{ localized: string }>): string[] {
  return items.map((i) => i.localized).sort();
}

async function cleanup(db: Db): Promise<void> {
  await db.delete(policyApprovals).where(sql`${policyApprovals.versionId} LIKE ${`${P}-%`}`);
  await db.delete(securityEvents).where(eq(securityEvents.policyId, TEAM_POLICY));
  await db.delete(policyVersions).where(eq(policyVersions.policyId, TEAM_POLICY));
  await db.delete(policies).where(eq(policies.id, TEAM_POLICY));
  await db.delete(userVocabularySnapshots).where(inArray(userVocabularySnapshots.ownerId, [...USER_IDS, TEAM, TEAM2]));
  await db.delete(userDomainTerms).where(inArray(userDomainTerms.userId, USER_IDS));
  await db.delete(domainTerms).where(eq(domainTerms.domain, DOMAIN));
  await db.delete(auditLogs).where(inArray(auditLogs.userId, USER_IDS));
  await db.delete(teamMembers).where(inArray(teamMembers.teamId, [TEAM, TEAM2]));
  await db.delete(teams).where(inArray(teams.id, [TEAM, TEAM2]));
  await db.delete(users).where(inArray(users.id, USER_IDS));
}

async function seed(db: Db): Promise<void> {
  const now = new Date();
  await db.insert(users).values(
    USER_IDS.map((id) => ({
      id,
      email: `${id}@example.test`,
      // 只有团队 owner 是 Pro：团队成员的个人套餐（Free）不含自定义词汇
      plan: id === U.owner ? 'pro' : 'free',
      updatedAt: now,
    })) as Array<typeof users.$inferInsert>,
  );
  await db.insert(teams).values([
    { id: TEAM, name: 'Vocab Team', slug: TEAM, ownerId: U.owner },
    { id: TEAM2, name: 'Other Team', slug: TEAM2, ownerId: U.outsider },
  ]);
  await db.insert(teamMembers).values([
    { id: `${P}-tm-owner`, teamId: TEAM, userId: U.owner, role: 'owner' },
    { id: `${P}-tm-admin`, teamId: TEAM, userId: U.admin, role: 'admin' },
    { id: `${P}-tm-member`, teamId: TEAM, userId: U.member, role: 'member' },
    { id: `${P}-tm-viewer`, teamId: TEAM, userId: U.viewer, role: 'viewer' },
    { id: `${P}-tm2-outsider`, teamId: TEAM2, userId: U.outsider, role: 'owner' },
  ]);
}

/** 直接写一条个人词条（Free 成员走 API 会被个人套餐拦住，这里模拟其升级前留下的词条）。 */
async function seedPersonalTerm(db: Db, userId: string, id: string, kind: string, canonical: string, localized: string, parent: string | null) {
  const termId = `dt-${P}-${id}`;
  await db.insert(domainTerms).values({
    id: termId, domain: DOMAIN, locale: 'de', kind, canonical, canonicalNorm: canonical.toLowerCase(),
    localized, localizedNorm: localized.toLowerCase(), parentCanonical: parent,
    parentCanonicalNorm: parent?.toLowerCase() ?? null, source: 'user', dedupKey: `${P}-${id}`,
  } as typeof domainTerms.$inferInsert);
  await db.insert(userDomainTerms).values({
    id: `udt-${P}-${id}`, userId, termId, ownerType: 'user', domain: DOMAIN, locale: 'de', kind,
  });
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('团队共享领域词汇（#672，真实 Postgres）', () => {
  const previous = globalForDb.__asterLocalDevDb;
  const db = createDb(undefined, { max: 4 });

  beforeAll(async () => {
    globalForDb.__asterLocalDevDb = db;
    await cleanup(db);
  }, 120_000);

  beforeEach(async () => {
    await cleanup(db);
    await seed(db);
    quota.cap = null;
    quota.holders = [];
  }, 60_000);

  afterAll(async () => {
    await cleanup(db);
    globalForDb.__asterLocalDevDb = previous;
    await db.$client.end({ timeout: 1 });
  }, 120_000);

  it('Free 成员在 Pro 团队可新增团队词条，额度按团队 owner 判定；个人词汇仍被本人 Free 套餐拦住', async () => {
    const team = await addTerm('member', struct('Driver', 'Fahrer'), TEAM);
    expect(team.status).toBe(201);
    expect(team.body.link).toMatchObject({ ownerType: 'team', teamId: TEAM, userId: U.member });
    expect(quota.holders).toEqual([U.owner]);

    const personal = await addTerm('member', struct('Driver', 'Fahrer'));
    expect(personal.status).toBe(403);
    expect(personal.body.error.code).toBe('plan_gate_required');
    expect(quota.holders).toEqual([U.owner, U.member]);
  });

  it('额度：团队词条按团队计数到 owner 套餐上限；团队词条不占创建者个人额度，个人词条也不占团队额度', async () => {
    quota.cap = 2;
    expect((await addTerm('member', struct('Driver', 'Fahrer'), TEAM)).status).toBe(201);
    expect((await addTerm('admin', struct('Car', 'Auto'), TEAM)).status).toBe(201);
    const over = await addTerm('member', struct('Truck', 'Laster'), TEAM);
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('quota_exceeded');

    // owner 的个人额度与团队额度分开计数：团队已满时 owner 仍可新增个人词条
    expect((await addTerm('owner', struct('Boat', 'Boot'))).status).toBe(201);
    expect((await addTerm('owner', struct('Plane', 'Flugzeug'))).status).toBe(201);
    expect((await addTerm('owner', struct('Bike', 'Rad'))).status).toBe(422);
    const teamList = await listTerms('owner', TEAM);
    expect(localizedOf(teamList.body.items)).toEqual(['Auto', 'Fahrer']);
  });

  it('团队词条与创建者个人视图互不混入：个人列表不含自己创建的团队词条，同一词条可同时为个人与团队所有', async () => {
    expect((await addTerm('owner', struct('Driver', 'Fahrer'), TEAM)).status).toBe(201);
    expect((await addTerm('owner', struct('Driver', 'Fahrer'))).status).toBe(201);
    const personal = await listTerms('owner');
    expect(personal.body.items).toHaveLength(1);
    expect(personal.body.items[0]).toMatchObject({ ownerType: 'user', teamId: null });
    const team = await listTerms('owner', TEAM);
    expect(team.body.items).toHaveLength(1);
    expect(team.body.items[0]).toMatchObject({ ownerType: 'team', teamId: TEAM });
  });

  it('viewer 只读：可列出团队词条，新增 / 修改 / 删除 / 恢复一律 403', async () => {
    const created = await addTerm('member', struct('Driver', 'Fahrer'), TEAM);
    const linkId = created.body.link.id as string;

    const list = await listTerms('viewer', TEAM);
    expect(list.status).toBe(200);
    expect(localizedOf(list.body.items)).toEqual(['Fahrer']);

    const add = await addTerm('viewer', struct('Car', 'Auto'), TEAM);
    expect(add.status).toBe(403);
    expect(add.body.error.code).toBe('team_role_insufficient');
    expect((await patchTerm('viewer', linkId, struct('Driver', 'Lenker'), TEAM)).status).toBe(403);
    expect((await deleteTerm('viewer', linkId, TEAM)).status).toBe(403);
    expect((await deleteTerm('member', linkId, TEAM)).status).toBe(200);
    expect((await restoreTerm('viewer', linkId, TEAM)).status).toBe(403);
  });

  it('member 只能改 / 删自己创建的团队词条；admin / owner 可改删任何团队词条', async () => {
    const byAdmin = (await addTerm('admin', struct('Car', 'Auto'), TEAM)).body.link.id as string;
    const byMember = (await addTerm('member', struct('Driver', 'Fahrer'), TEAM)).body.link.id as string;

    const forbidden = await patchTerm('member', byAdmin, struct('Car', 'Wagen'), TEAM);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('team_role_insufficient');
    expect((await deleteTerm('member', byAdmin, TEAM)).status).toBe(403);

    const own = await patchTerm('member', byMember, struct('Driver', 'Lenker'), TEAM);
    expect(own.status).toBe(200);
    expect(own.body.link).toMatchObject({ localized: 'Lenker', ownerType: 'team' });

    expect((await patchTerm('admin', byMember, struct('Driver', 'Fahrer'), TEAM)).status).toBe(200);
    expect((await deleteTerm('owner', byMember, TEAM)).status).toBe(200);
    expect((await restoreTerm('admin', byMember, TEAM)).status).toBe(200);
  });

  it('团队内同作用域写法冲突照常拒绝（ADR 0051 §8 在团队归属内生效）', async () => {
    expect((await addTerm('member', struct('Driver', 'Fahrer'), TEAM)).status).toBe(201);
    const conflict = await addTerm('admin', struct('Pilot', 'Fahrer'), TEAM);
    expect(conflict.status).toBe(400);
    expect(conflict.body.error.code).toBe('validation_failed');
  });

  it('跨团队不可见：团队外用户读写本团队词汇 403，自己团队的列表也不含本团队词条', async () => {
    await addTerm('member', struct('Driver', 'Fahrer'), TEAM);
    const list = await listTerms('outsider', TEAM);
    expect(list.status).toBe(403);
    expect(list.body.error.code).toBe('team_forbidden');
    expect((await addTerm('outsider', struct('Car', 'Auto'), TEAM)).status).toBe(403);
    expect((await teamVersion('outsider', TEAM)).status).toBe(403);
    const own = await listTerms('outsider', TEAM2);
    expect(own.status).toBe(200);
    expect(own.body.items).toEqual([]);
  });

  it('离队后不可见、不可用：列表 / 新增 / 修改 403，个人策略编译也不含团队词条；团队词条留在团队', async () => {
    const linkId = (await addTerm('member', struct('Driver', 'Fahrer'), TEAM)).body.link.id as string;
    await db.delete(teamMembers).where(eq(teamMembers.id, `${P}-tm-member`));

    expect((await listTerms('member', TEAM)).status).toBe(403);
    expect((await addTerm('member', struct('Car', 'Auto'), TEAM)).status).toBe(403);
    expect((await patchTerm('member', linkId, struct('Driver', 'Lenker'), TEAM)).status).toBe(403);
    expect((await listTerms('member')).body.items).toEqual([]);

    const personal = await loadSaveVocabulary(U.member, POLICY_CTX);
    expect(personal.vocabulary).toBeNull();

    // 词条不跟人走：团队里仍在
    expect(localizedOf((await listTerms('admin', TEAM)).body.items)).toEqual(['Fahrer']);
  });

  it('团队词汇版本：成员可轮询，团队词条变化后版本变化', async () => {
    const before = await teamVersion('viewer', TEAM);
    expect(before.status).toBe(200);
    await addTerm('member', struct('Driver', 'Fahrer'), TEAM);
    const after = await teamVersion('viewer', TEAM);
    expect(after.body.version).not.toBe(before.body.version);
  });

  it('团队策略编译用「团队 + 作者」词汇，冲突时团队优先；个人策略只用作者词汇', async () => {
    // 团队：Fahrer → Driver；作者个人：Fahrer → Pilot（与团队冲突，被遮蔽）、alter → age（挂在 Driver 下）
    await addTerm('admin', struct('Driver', 'Fahrer'), TEAM);
    await seedPersonalTerm(db, U.member, 'pilot', 'struct', 'Pilot', 'Fahrer', null);
    await seedPersonalTerm(db, U.member, 'age', 'field', 'age', 'alter', 'Driver');

    const teamVocab = (await loadSaveVocabulary(U.member, POLICY_CTX, { teamId: TEAM })).vocabulary;
    expect(teamVocab?.structs.map((m) => m.canonical)).toEqual(['Driver']);
    expect(teamVocab?.fields.map((m) => [m.canonical, m.parent])).toEqual([['age', 'Driver']]);

    const personalVocab = (await loadSaveVocabulary(U.member, POLICY_CTX)).vocabulary;
    expect(personalVocab?.structs.map((m) => m.canonical)).toEqual(['Pilot']);
    expect(personalVocab?.fields.map((m) => m.canonical)).toEqual(['age']);
  });

  it('审批冻结团队策略：团队词条冻进团队快照、作者词条（剔除被遮蔽的）冻进作者快照，执行端合并结果与保存时一致', async () => {
    await addTerm('admin', struct('Driver', 'Fahrer'), TEAM);
    await seedPersonalTerm(db, U.member, 'pilot', 'struct', 'Pilot', 'Fahrer', null);
    await seedPersonalTerm(db, U.member, 'age', 'field', 'age', 'alter', 'Driver');
    const now = new Date();
    await db.insert(policies).values({
      id: TEAM_POLICY, userId: U.member, teamId: TEAM, name: TEAM_POLICY, content: SOURCE, version: 1, updatedAt: now,
    } as typeof policies.$inferInsert);
    await db.insert(policyVersions).values({
      id: `${TEAM_POLICY}-v1`, policyId: TEAM_POLICY, version: 1, content: SOURCE, source: SOURCE,
      status: 'PENDING_APPROVAL', createdBy: U.member,
    });

    await approveVersion({ policyId: TEAM_POLICY, version: 1, approverId: U.admin, decision: 'APPROVED' });

    const [row] = await db
      .select({ refs: policyVersions.vocabularySnapshotIds, status: policyVersions.status })
      .from(policyVersions)
      .where(eq(policyVersions.id, `${TEAM_POLICY}-v1`));
    expect(row?.status).toBe('APPROVED');
    const refs = row!.refs as SnapshotRef[];
    const snaps = await db
      .select({ ownerType: userVocabularySnapshots.ownerType, ownerId: userVocabularySnapshots.ownerId, termIds: userVocabularySnapshots.termIds })
      .from(userVocabularySnapshots)
      .where(inArray(userVocabularySnapshots.id, refs.map((r) => r.snapshotId)));
    expect(snaps.map((s) => `${s.ownerType}:${s.ownerId}`).sort()).toEqual([`team:${TEAM}`, `user:${U.member}`].sort());
    const authorSnap = snaps.find((s) => s.ownerType === 'user')!;
    expect(authorSnap.termIds).toEqual([`dt-${P}-age`]);

    const frozen = await loadVocabularyForExecution(refs, POLICY_CTX);
    const live = (await loadSaveVocabulary(U.member, POLICY_CTX, { teamId: TEAM })).vocabulary;
    expect(frozen?.structs.map((m) => m.canonical)).toEqual(['Driver']);
    expect(frozen?.fields.map((m) => m.canonical)).toEqual(live?.fields.map((m) => m.canonical));
  });
});
