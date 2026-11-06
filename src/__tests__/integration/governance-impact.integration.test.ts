// 控制项影响分析（#739）：真实 Postgres + 真实路由处理器。
//
// 夹具：团队 T（owner / member / viewer）、团队外用户 outsider（自己的个人策略）、已被移除的 ex。
// 断言：只列调用方可见的策略；回收站里的不出现；无 @control 的策略进「未关联」桶；
// 版本按引用列出、active 按当前可执行版本判定；近 30 天执行数与待审批数按策略汇总。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts governance-impact

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const current = vi.hoisted(() => ({ userId: null as string | null }));
const sessionOf = () => (current.userId ? { user: { id: current.userId } } : null);

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ getSession: vi.fn(async () => sessionOf()), auth: vi.fn(async () => sessionOf()) }));
vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext: vi.fn(async () => { throw new Error('not cloudflare'); }) }));

import { createDb } from '@/db';
import { executions, policies, policyVersions, teamMembers, teams, users } from '@/lib/prisma';
import { loadGovernanceOverview, loadControlImpact, type ImpactPolicy } from '@/lib/governance-impact';
import * as impactRoute from '@/app/api/governance/controls/[id]/impact/route';

const P = 'it-gov';
const TEAM = `${P}-team`;
const U = {
  owner: `${P}-owner`,
  member: `${P}-member`,
  viewer: `${P}-viewer`,
  outsider: `${P}-outsider`,
  ex: `${P}-ex`,
} as const;
const USER_IDS = Object.values(U);

const POL = {
  art14: `${P}-pol-art14`, // 团队策略：v1 APPROVED 默认版引用 ART14，v2 草稿引用 ART14+GDPR22
  gdpr: `${P}-pol-gdpr`, // 团队策略：v1 APPROVED 引用 ART14，v2 APPROVED 默认版只引用 GDPR22（ART14 不再 active）
  plain: `${P}-pol-plain`, // 团队策略：无 @control
  pending: `${P}-pol-pending`, // 团队策略：v1 待审批引用 SOX
  deleted: `${P}-pol-deleted`, // 回收站里的团队策略，引用 ART14
  outsider: `${P}-pol-outsider`, // outsider 的个人策略，引用 ART14
  ownerPersonal: `${P}-pol-owner-personal`, // owner 的个人策略，引用 ART14
  archived: `${P}-pol-archived`, // 团队策略：只有已归档版本引用 ART14
  escaped: `${P}-pol-escaped`, // 团队策略：以转义写法 @control("GDPR:ART\\u0036") 引用 GDPR:ART6
  broken: `${P}-pol-broken`, // 团队策略：v1 含 @control 字样但语法错误（无法解析）
} as const;
const POLICY_IDS = Object.values(POL);

const withControls = (...keys: string[]) =>
  `Module m.\n\n${keys.map((k) => `@control("${k}")`).join('\n')}\nRule r given x as Int, produce Verdict:\n  Return Verdict.allow().\n`;
const PLAIN = 'Module m.\n\nRule r given x as Int, produce Bool:\n  Return x at least 1.\n';
const ESCAPED = 'Module m.\n\n@control("GDPR:ART\\u0036")\nRule r given x as Int, produce Verdict:\n  Return Verdict.allow().\n';
const BROKEN = 'Module m.\n\n@control("GDPR:ART6")\nRule r given x as Int, produce Bool:\n  Return x at least .\n';

type Db = ReturnType<typeof createDb>;
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

async function cleanup(db: Db): Promise<void> {
  await db.delete(executions).where(inArray(executions.policyId, POLICY_IDS));
  await db.delete(policyVersions).where(inArray(policyVersions.policyId, POLICY_IDS));
  await db.delete(policies).where(inArray(policies.id, POLICY_IDS));
  await db.delete(teamMembers).where(eq(teamMembers.teamId, TEAM));
  await db.delete(teams).where(eq(teams.id, TEAM));
  await db.delete(users).where(inArray(users.id, USER_IDS));
}

async function seed(db: Db): Promise<void> {
  const now = new Date();
  await db.insert(users).values(
    USER_IDS.map((id) => ({ id, email: `${id}@example.test`, plan: 'pro', updatedAt: now })) as Array<typeof users.$inferInsert>,
  );
  await db.insert(teams).values({ id: TEAM, name: 'Governance Team', slug: TEAM, ownerId: U.owner });
  await db.insert(teamMembers).values([
    { id: `${P}-tm-owner`, teamId: TEAM, userId: U.owner, role: 'owner' },
    { id: `${P}-tm-member`, teamId: TEAM, userId: U.member, role: 'member' },
    { id: `${P}-tm-viewer`, teamId: TEAM, userId: U.viewer, role: 'viewer' },
  ]);

  const policy = (id: string, userId: string, teamId: string | null, content: string, extra: Partial<typeof policies.$inferInsert> = {}) => ({
    id, userId, teamId, name: id, content, version: 1, updatedAt: now, ...extra,
  });
  await db.insert(policies).values([
    policy(POL.art14, U.owner, TEAM, withControls('EU_AI_ACT:ART14')),
    policy(POL.gdpr, U.member, TEAM, withControls('GDPR:ART22')),
    policy(POL.plain, U.member, TEAM, PLAIN),
    policy(POL.pending, U.member, TEAM, withControls('SOX:404')),
    policy(POL.deleted, U.owner, TEAM, withControls('EU_AI_ACT:ART14'), { deletedAt: now, deletedBy: U.owner }),
    policy(POL.outsider, U.outsider, null, withControls('EU_AI_ACT:ART14')),
    policy(POL.ownerPersonal, U.owner, null, withControls('EU_AI_ACT:ART14')),
    policy(POL.archived, U.ex, TEAM, withControls('EU_AI_ACT:ART14')),
    policy(POL.escaped, U.member, TEAM, ESCAPED),
    policy(POL.broken, U.member, TEAM, BROKEN),
  ] as Array<typeof policies.$inferInsert>);

  const version = (
    policyId: string,
    n: number,
    content: string,
    status: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'ARCHIVED',
    isDefault = false,
  ) => ({ id: `${policyId}-v${n}`, policyId, version: n, content, source: content, status, isDefault, createdBy: U.owner });
  await db.insert(policyVersions).values([
    version(POL.art14, 1, withControls('EU_AI_ACT:ART14'), 'APPROVED', true),
    version(POL.art14, 2, withControls('EU_AI_ACT:ART14', 'GDPR:ART22'), 'DRAFT'),
    version(POL.gdpr, 1, withControls('EU_AI_ACT:ART14'), 'APPROVED'),
    version(POL.gdpr, 2, withControls('GDPR:ART22'), 'APPROVED', true),
    version(POL.plain, 1, PLAIN, 'APPROVED', true),
    version(POL.pending, 1, withControls('SOX:404'), 'PENDING_APPROVAL'),
    version(POL.deleted, 1, withControls('EU_AI_ACT:ART14'), 'APPROVED', true),
    version(POL.outsider, 1, withControls('EU_AI_ACT:ART14'), 'APPROVED', true),
    version(POL.ownerPersonal, 1, withControls('EU_AI_ACT:ART14'), 'DRAFT'),
    version(POL.archived, 1, withControls('EU_AI_ACT:ART14'), 'ARCHIVED'),
    version(POL.escaped, 1, ESCAPED, 'APPROVED', true),
    version(POL.broken, 1, BROKEN, 'DRAFT'),
  ]);

  const day = 86_400_000;
  const exec = (id: string, policyId: string, userId: string, tenantId: string, ageDays: number) => ({
    id: `${P}-exec-${id}`,
    policyId, userId, tenantId,
    input: { x: 1 }, output: { allowed: true }, durationMs: 3, success: true,
    decision: 'approved' as const, source: 'dashboard' as const,
    createdAt: new Date(now.getTime() - ageDays * day),
  });
  await db.insert(executions).values([
    exec('a1', POL.art14, U.owner, TEAM, 1),
    exec('a2', POL.art14, U.member, TEAM, 10),
    exec('a3', POL.art14, U.outsider, U.outsider, 2), // 团队外用户经公开执行留下的记录：团队策略聚合口径计入
    exec('a-old', POL.art14, U.owner, TEAM, 45), // 超过 30 天：不计
    exec('p1', POL.ownerPersonal, U.owner, U.owner, 3),
    exec('p-other', POL.ownerPersonal, U.member, U.member, 3), // 个人策略只计所有者本人的执行
  ] as Array<typeof executions.$inferInsert>);
}

function as(userId: string | null): void {
  current.userId = userId;
}

function impactRequest(key: string): Promise<Response> {
  const id = encodeURIComponent(key);
  return impactRoute.GET(new NextRequest(`http://localhost/api/governance/controls/${id}/impact`), { params: Promise.resolve({ id }) });
}

const byId = (list: ImpactPolicy[]) => new Map(list.map((p) => [p.id, p]));

describe.skipIf(process.env.LICENSE_E2E !== '1')('控制项影响分析（真实 Postgres）', () => {
  const previous = globalForDb.__asterLocalDevDb;
  const db = createDb(undefined, { max: 4 });

  beforeAll(async () => {
    globalForDb.__asterLocalDevDb = db;
  }, 120_000);

  beforeEach(async () => {
    await cleanup(db);
    await seed(db);
  }, 120_000);

  afterAll(async () => {
    await cleanup(db);
    globalForDb.__asterLocalDevDb = previous;
    await db.$client.end({ timeout: 1 });
  }, 120_000);

  it('团队 owner：列出团队策略 + 本人个人策略；回收站、归档版本、他人个人策略不出现', async () => {
    const impact = await loadControlImpact(U.owner, 'EU_AI_ACT:ART14');
    expect(impact.registryVersion).toBeTruthy();
    expect(impact.registry?.framework).toBe('EU_AI_ACT');
    expect(impact.policies.map((p) => p.id).sort()).toEqual([POL.art14, POL.gdpr, POL.ownerPersonal].sort());

    const m = byId(impact.policies);
    const art14 = m.get(POL.art14)!;
    expect(art14.teamId).toBe(TEAM);
    expect(art14.teamName).toBe('Governance Team');
    expect(art14.active).toBe(true);
    expect(art14.versions).toEqual([
      { version: 1, status: 'APPROVED', isDefault: true },
      { version: 2, status: 'DRAFT', isDefault: false },
    ]);
    expect(art14.executions30d).toBe(3);
    expect(art14.pendingApprovals).toBe(0);

    // v2 默认版已不再引用 ART14：仍列出（v1 引用），但 active=false
    const gdpr = m.get(POL.gdpr)!;
    expect(gdpr.active).toBe(false);
    expect(gdpr.versions).toEqual([{ version: 1, status: 'APPROVED', isDefault: false }]);

    const personal = m.get(POL.ownerPersonal)!;
    expect(personal.teamId).toBeNull();
    expect(personal.active).toBe(false); // 只有草稿
    expect(personal.executions30d).toBe(1); // 他人对个人策略的执行不计
  });

  it('转义写法按编译器规则解码；无法解析的版本记入 unparsed 而不是静默丢弃', async () => {
    const impact = await loadControlImpact(U.member, 'GDPR:ART6');
    expect(impact.policies.map((p) => p.id)).toEqual([POL.escaped]);
    expect(impact.policies[0].active).toBe(true);
    expect(impact.unparsed).toEqual([{ policyId: POL.broken, version: 1, diagnostics: expect.arrayContaining([expect.any(String)]) }]);

    const overview = await loadGovernanceOverview(U.member);
    expect(overview.unparsed.map((u) => u.policyId)).toEqual([POL.broken]);
    // 无法解析的策略既不进控制项清单也不进未关联桶
    expect(overview.unlinked.map((p) => p.id)).not.toContain(POL.broken);
    expect(overview.frameworks.flatMap((f) => f.controls.flatMap((c) => c.policies.map((p) => p.id)))).not.toContain(POL.broken);
  });

  it('待审批数按策略汇总', async () => {
    const impact = await loadControlImpact(U.member, 'SOX:404');
    expect(impact.policies.map((p) => p.id)).toEqual([POL.pending]);
    expect(impact.policies[0].pendingApprovals).toBe(1);
    expect(impact.policies[0].active).toBe(false);
  });

  it('团队 viewer 可见团队策略；团队外用户与被移除成员只见自己的', async () => {
    const viewer = await loadControlImpact(U.viewer, 'EU_AI_ACT:ART14');
    expect(viewer.policies.map((p) => p.id).sort()).toEqual([POL.art14, POL.gdpr].sort());

    const outsider = await loadControlImpact(U.outsider, 'EU_AI_ACT:ART14');
    expect(outsider.policies.map((p) => p.id)).toEqual([POL.outsider]);

    const ex = await loadControlImpact(U.ex, 'EU_AI_ACT:ART14');
    expect(ex.policies).toEqual([]);
  });

  it('总览：框架 → 控制项 → 策略，无 @control 的策略进未关联桶', async () => {
    const overview = await loadGovernanceOverview(U.owner);
    const euAiAct = overview.frameworks.find((f) => f.id === 'EU_AI_ACT')!;
    const art14 = euAiAct.controls.find((c) => c.key === 'EU_AI_ACT:ART14')!;
    expect(art14.policies.map((p) => p.id).sort()).toEqual([POL.art14, POL.gdpr, POL.ownerPersonal].sort());
    const gdpr22 = overview.frameworks.find((f) => f.id === 'GDPR')!.controls.find((c) => c.key === 'GDPR:ART22')!;
    expect(gdpr22.policies.map((p) => p.id).sort()).toEqual([POL.art14, POL.gdpr].sort());
    expect(gdpr22.policies.find((p) => p.id === POL.gdpr)!.active).toBe(true);
    // 注册表里没有策略引用的控制项照样列出（空清单）
    expect(overview.frameworks.find((f) => f.id === 'GDPR')!.controls.find((c) => c.key === 'GDPR:ART6')!.policies.map((p) => p.id)).toEqual([POL.escaped]);
    // 只有归档版本引用、以及完全没有 @control 的策略 → 未关联
    expect(overview.unlinked.map((p) => p.id).sort()).toEqual([POL.plain, POL.archived].sort());
    expect(overview.unregistered).toEqual([]);
  });

  it('未登记的控制键归入「未登记」分组', async () => {
    const now = new Date();
    await db.insert(policyVersions).values({
      id: `${POL.plain}-v2`, policyId: POL.plain, version: 2, content: withControls('ACME:ART1'), source: withControls('ACME:ART1'),
      status: 'DRAFT', createdBy: U.member, createdAt: now,
    });
    const overview = await loadGovernanceOverview(U.member);
    expect(overview.unregistered.map((g) => g.key)).toEqual(['ACME:ART1']);
    expect(overview.unregistered[0].policies.map((p) => p.id)).toEqual([POL.plain]);
    expect(overview.unlinked.map((p) => p.id)).toEqual([POL.archived]);

    const impact = await loadControlImpact(U.member, 'ACME:ART1');
    expect(impact.registry).toBeNull();
    expect(impact.policies.map((p) => p.id)).toEqual([POL.plain]);
  });

  it('GET /api/governance/controls/{id}/impact：未登录 401；只返回调用方可见的策略', async () => {
    as(null);
    expect((await impactRequest('EU_AI_ACT:ART14')).status).toBe(401);

    as(U.viewer);
    const res = await impactRequest('EU_AI_ACT:ART14');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { control: string; policies: ImpactPolicy[] };
    expect(body.control).toBe('EU_AI_ACT:ART14');
    expect(body.policies.map((p) => p.id).sort()).toEqual([POL.art14, POL.gdpr].sort());

    as(U.outsider);
    const other = (await (await impactRequest('EU_AI_ACT:ART14')).json()) as { policies: ImpactPolicy[] };
    expect(other.policies.map((p) => p.id)).toEqual([POL.outsider]);
  });

  it('GET /api/governance/controls/{id}/impact：非法键 400', async () => {
    as(U.owner);
    expect((await impactRequest('not a key')).status).toBe(400);
  });
});
