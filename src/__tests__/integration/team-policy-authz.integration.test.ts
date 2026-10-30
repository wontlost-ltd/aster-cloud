// 团队策略授权矩阵（#669 #670 #671 #673 #674），真实 Postgres + 真实路由处理器。
//
// 每个用例前重建同一组夹具：团队 T（owner / admin / member / viewer），团队外用户 outsider，
// 已被移除的创建者 ex（其创建的团队策略仍留在团队里）。逐路由断言矩阵的每一格，
// 包括越权反例：被移除成员、viewer 写操作、团队 key 访问个人策略、团队外用户。
// 外部依赖（aster-api 执行 / What-If / Cedar、KV 缓存）用替身，授权与数据查询全部走真库。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts team-policy-authz

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const current = vi.hoisted(() => ({ userId: null as string | null }));
const sessionOf = () => (current.userId ? { user: { id: current.userId } } : null);

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ getSession: vi.fn(async () => sessionOf()), auth: vi.fn(async () => sessionOf()) }));
vi.mock('@/auth', () => ({ getSession: vi.fn(async () => sessionOf()), auth: vi.fn(async () => sessionOf()) }));
vi.mock('@/lib/cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cache')>()),
  getCachedPolicyMeta: vi.fn(async () => null),
  cachePolicyMeta: vi.fn(async () => undefined),
  invalidatePolicyCache: vi.fn(async () => undefined),
}));
vi.mock('@/lib/metrics/aha-detection', () => ({ recordAhaMomentIfFirst: vi.fn(async () => false) }));
vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext: vi.fn(async () => { throw new Error('not cloudflare'); }) }));
vi.mock('@/services/policy/runner-parity-from-execution', () => ({
  maybeRunParityForExecution: vi.fn(async () => null),
  RUNNER_LAUNCHER_HMAC_ROLE: 'runner-launcher',
}));
vi.mock('@/services/policy/cnl-executor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/policy/cnl-executor')>()),
  executePolicyUnified: vi.fn(async () => ({
    allowed: true,
    approved: true,
    matchedRules: [],
    deniedReasons: [],
    result: true,
    executedFunction: 'r',
    metadata: {
      evaluatedAt: new Date().toISOString(),
      policyId: 'p',
      policyName: 'p',
      ruleCount: 1,
      matchedRuleCount: 0,
      denyCount: 0,
      engine: 'aster-cnl' as const,
    },
  })),
}));
vi.mock('@/services/policy/policy-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/policy/policy-api')>()),
  createPolicyApiClient: vi.fn(() => ({
    createWhatIfBatch: vi.fn(async () => ({ batchId: 'b-1', status: 'PENDING' })),
    getWhatIfBatch: vi.fn(async () => ({ batchId: 'b-1', status: 'PENDING' })),
  })),
}));
vi.mock('@/lib/snapshot-pusher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/snapshot-pusher')>()),
  pushApiKeySnapshot: vi.fn(async () => undefined),
}));

import { createDb } from '@/db';
import {
  apiKeys,
  complianceReports,
  executions,
  policies,
  policyApprovals,
  policyRecycleBins,
  policyVersions,
  securityEvents,
  teamMembers,
  teams,
  usageRecords,
  users,
} from '@/lib/prisma';
import { hashApiKey } from '@/lib/api-keys';
import * as policyRoute from '@/app/api/policies/[id]/route';
import * as policiesRoute from '@/app/api/policies/route';
import * as executeRoute from '@/app/api/policies/[id]/execute/route';
import * as logsRoute from '@/app/api/policies/[id]/logs/route';
import * as funnelRoute from '@/app/api/policies/[id]/funnel/route';
import * as whatifStubRoute from '@/app/api/policies/[id]/whatif/route';
import * as cedarRoute from '@/app/api/policies/[id]/export/cedar/route';
import * as trashItemRoute from '@/app/api/policies/trash/[id]/route';
import * as trashRoute from '@/app/api/policies/trash/route';
import * as reportsRoute from '@/app/api/reports/route';
import * as teamPoliciesRoute from '@/app/api/teams/[teamId]/policies/route';
import * as versionsRoute from '@/app/api/v1/policies/[id]/versions/route';
import * as versionDetailRoute from '@/app/api/v1/policies/[id]/versions/[version]/route';
import * as submitRoute from '@/app/api/v1/policies/[id]/versions/[version]/submit/route';
import * as rejectRoute from '@/app/api/v1/policies/[id]/versions/[version]/reject/route';
import * as setDefaultRoute from '@/app/api/v1/policies/[id]/versions/[version]/set-default/route';
import * as archiveRoute from '@/app/api/v1/policies/[id]/versions/[version]/archive/route';
import * as whatifBatchesRoute from '@/app/api/v1/policies/[id]/whatif-batches/route';
import * as whatifBatchRoute from '@/app/api/v1/policies/[id]/whatif-batches/[batchId]/route';
import * as v1ListRoute from '@/app/api/v1/policies/route';
import * as v1ExecuteRoute from '@/app/api/v1/policies/[id]/execute/route';

const P = 'it-tpa';
const TEAM = `${P}-team`;
const U = {
  owner: `${P}-owner`,
  admin: `${P}-admin`,
  member: `${P}-member`,
  viewer: `${P}-viewer`,
  outsider: `${P}-outsider`,
  ex: `${P}-ex`,
} as const;
type Actor = keyof typeof U;
const USER_IDS = Object.values(U);

const POL = {
  own: `${P}-pol-own`, // owner 创建的团队策略
  mem: `${P}-pol-mem`, // member 创建的团队策略，v1 待审批
  ex: `${P}-pol-ex`, // 已被移除的 ex 创建、仍留在团队里的策略
  view: `${P}-pol-view`, // 被降为 viewer 的成员当初创建的团队策略
  personal: `${P}-pol-personal`, // owner 的个人策略
  deleted: `${P}-pol-deleted`, // 已移入回收站的团队策略
} as const;
const POLICY_IDS = Object.values(POL);
const SOURCE = 'Module m.\n\nRule r given x as Int, produce Bool:\n  Return x at least 1.\n';

const KEY = {
  ownerTeam: `ak_${'a'.repeat(64)}`,
  ownerPersonal: `ak_${'b'.repeat(64)}`,
  memberTeam: `ak_${'c'.repeat(64)}`,
};

type Db = ReturnType<typeof createDb>;
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

async function cleanup(db: Db): Promise<void> {
  await db.delete(complianceReports).where(inArray(complianceReports.userId, USER_IDS));
  await db.delete(securityEvents).where(inArray(securityEvents.userId, USER_IDS));
  await db.delete(executions).where(inArray(executions.policyId, POLICY_IDS));
  await db.delete(usageRecords).where(inArray(usageRecords.userId, USER_IDS));
  await db.delete(policyApprovals).where(sql`${policyApprovals.versionId} LIKE ${`${P}-%`}`);
  await db.delete(policyVersions).where(inArray(policyVersions.policyId, POLICY_IDS));
  await db.delete(policyRecycleBins).where(inArray(policyRecycleBins.policyId, POLICY_IDS));
  await db.delete(policies).where(inArray(policies.id, POLICY_IDS));
  await db.delete(apiKeys).where(inArray(apiKeys.userId, USER_IDS));
  await db.delete(teamMembers).where(eq(teamMembers.teamId, TEAM));
  await db.delete(teams).where(eq(teams.id, TEAM));
  await db.delete(users).where(inArray(users.id, USER_IDS));
}

async function seed(db: Db): Promise<void> {
  const now = new Date();
  await db.insert(users).values(
    USER_IDS.map((id) => ({
      id,
      email: `${id}@example.test`,
      // member 为 Free，用来验证团队 key 的配额按团队 owner 计（#671）
      plan: id === U.member ? 'free' : 'pro',
      updatedAt: now,
    })) as Array<typeof users.$inferInsert>,
  );
  await db.insert(teams).values({ id: TEAM, name: 'Authz Team', slug: TEAM, ownerId: U.owner });
  await db.insert(teamMembers).values([
    { id: `${P}-tm-owner`, teamId: TEAM, userId: U.owner, role: 'owner' },
    { id: `${P}-tm-admin`, teamId: TEAM, userId: U.admin, role: 'admin' },
    { id: `${P}-tm-member`, teamId: TEAM, userId: U.member, role: 'member' },
    { id: `${P}-tm-viewer`, teamId: TEAM, userId: U.viewer, role: 'viewer' },
  ]);

  const policy = (id: string, userId: string, teamId: string | null, extra: Partial<typeof policies.$inferInsert> = {}) => ({
    id,
    userId,
    teamId,
    name: id,
    content: SOURCE,
    version: 1,
    updatedAt: now,
    ...extra,
  });
  await db.insert(policies).values([
    policy(POL.own, U.owner, TEAM),
    policy(POL.mem, U.member, TEAM),
    policy(POL.ex, U.ex, TEAM),
    policy(POL.view, U.viewer, TEAM),
    policy(POL.personal, U.owner, null),
    policy(POL.deleted, U.owner, TEAM, { deletedAt: now, deletedBy: U.owner }),
  ] as Array<typeof policies.$inferInsert>);
  await db.insert(policyRecycleBins).values({
    id: `${P}-rb-deleted`,
    policyId: POL.deleted,
    userId: U.owner,
    snapshot: { id: POL.deleted },
    deletedBy: U.owner,
    expiresAt: new Date(now.getTime() + 86_400_000),
  });

  const version = (policyId: string, createdBy: string, status: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED', n = 1) => ({
    id: `${policyId}-v${n}`,
    policyId,
    version: n,
    content: SOURCE,
    source: SOURCE,
    status,
    createdBy,
  });
  await db.insert(policyVersions).values([
    version(POL.own, U.owner, 'DRAFT'),
    version(POL.own, U.admin, 'PENDING_APPROVAL', 2),
    version(POL.own, U.owner, 'APPROVED', 3),
    version(POL.mem, U.member, 'PENDING_APPROVAL'),
    version(POL.ex, U.ex, 'DRAFT'),
    version(POL.view, U.viewer, 'DRAFT'),
    version(POL.personal, U.owner, 'DRAFT'),
  ]);

  const exec = (id: string, policyId: string, userId: string) => ({
    id: `${P}-exec-${id}`,
    policyId,
    userId,
    input: { x: 1 },
    output: { allowed: true },
    durationMs: 3,
    success: true,
    decision: 'approved' as const,
    source: 'dashboard' as const,
    canonicalInputHash: 'h'.repeat(64),
  });
  await db.insert(executions).values([
    exec('own-1', POL.own, U.owner),
    exec('own-2', POL.own, U.owner),
    exec('own-3', POL.own, U.member),
    exec('mem-1', POL.mem, U.member),
    exec('mem-2', POL.mem, U.owner),
    exec('personal-1', POL.personal, U.owner),
  ] as Array<typeof executions.$inferInsert>);

  await db.insert(apiKeys).values([
    { id: `${P}-key-owner-team`, userId: U.owner, teamId: TEAM, name: 't', key: hashApiKey(KEY.ownerTeam), prefix: 'aaaaaaaa' },
    { id: `${P}-key-owner-personal`, userId: U.owner, teamId: null, name: 'p', key: hashApiKey(KEY.ownerPersonal), prefix: 'bbbbbbbb' },
    { id: `${P}-key-member-team`, userId: U.member, teamId: TEAM, name: 'm', key: hashApiKey(KEY.memberTeam), prefix: 'cccccccc' },
  ]);
}

const BASE = 'http://localhost';

function as(actor: Actor | null): void {
  current.userId = actor ? U[actor] : null;
}

function jsonRequest(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const versionParams = (id: string, version: number) => ({ params: Promise.resolve({ id, version: String(version) }) });

const call = {
  get: (actor: Actor, id: string) => (as(actor), policyRoute.GET(jsonRequest('GET', `/api/policies/${id}`), idParams(id))),
  put: (actor: Actor, id: string) =>
    (as(actor), policyRoute.PUT(jsonRequest('PUT', `/api/policies/${id}`, { description: `edited by ${actor}` }), idParams(id))),
  del: (actor: Actor, id: string) => (as(actor), policyRoute.DELETE(jsonRequest('DELETE', `/api/policies/${id}`), idParams(id))),
  execute: (actor: Actor, id: string) =>
    (as(actor), executeRoute.POST(jsonRequest('POST', `/api/policies/${id}/execute`, { input: { x: 1 }, functionName: 'r' }), idParams(id))),
  logs: (actor: Actor, id: string) => (as(actor), logsRoute.GET(jsonRequest('GET', `/api/policies/${id}/logs`), idParams(id))),
  logsRecent: (actor: Actor, id: string) =>
    (as(actor), logsRoute.GET(jsonRequest('GET', `/api/policies/${id}/logs?mode=recent`), idParams(id))),
  logsStats: (actor: Actor, id: string) =>
    (as(actor), logsRoute.GET(jsonRequest('GET', `/api/policies/${id}/logs?mode=stats`), idParams(id))),
  funnel: (actor: Actor, id: string) => (as(actor), funnelRoute.GET(jsonRequest('GET', `/api/policies/${id}/funnel`), idParams(id))),
  whatifStub: (actor: Actor, id: string) =>
    (as(actor), whatifStubRoute.GET(jsonRequest('GET', `/api/policies/${id}/whatif`), idParams(id))),
  cedar: (actor: Actor, id: string) =>
    (as(actor), cedarRoute.POST(jsonRequest('POST', `/api/policies/${id}/export/cedar`, {}), idParams(id))),
  restore: (actor: Actor, id: string) =>
    (as(actor), trashItemRoute.POST(jsonRequest('POST', `/api/policies/trash/${id}`), idParams(id))),
  purge: (actor: Actor, id: string) =>
    (as(actor), trashItemRoute.DELETE(jsonRequest('DELETE', `/api/policies/trash/${id}`), idParams(id))),
  versions: (actor: Actor, id: string) =>
    (as(actor), versionsRoute.GET(jsonRequest('GET', `/api/v1/policies/${id}/versions`), idParams(id))),
  createVersion: (actor: Actor, id: string) =>
    (as(actor), versionsRoute.POST(jsonRequest('POST', `/api/v1/policies/${id}/versions`, { source: 'not compiled here' }), idParams(id))),
  versionDetail: (actor: Actor, id: string, v: number) =>
    (as(actor), versionDetailRoute.GET(jsonRequest('GET', `/api/v1/policies/${id}/versions/${v}`), versionParams(id, v))),
  submit: (actor: Actor, id: string, v: number) =>
    (as(actor), submitRoute.POST(jsonRequest('POST', `/api/v1/policies/${id}/versions/${v}/submit`, {}), versionParams(id, v))),
  reject: (actor: Actor, id: string, v: number) =>
    (as(actor), rejectRoute.POST(jsonRequest('POST', `/api/v1/policies/${id}/versions/${v}/reject`, { comment: 'no' }), versionParams(id, v))),
  setDefault: (actor: Actor, id: string, v: number) =>
    (as(actor), setDefaultRoute.POST(jsonRequest('POST', `/api/v1/policies/${id}/versions/${v}/set-default`, {}), versionParams(id, v))),
  archive: (actor: Actor, id: string, v: number) =>
    (as(actor), archiveRoute.POST(jsonRequest('POST', `/api/v1/policies/${id}/versions/${v}/archive`, {}), versionParams(id, v))),
  whatif: (actor: Actor, id: string) =>
    (as(actor),
    whatifBatchesRoute.POST(
      jsonRequest('POST', `/api/v1/policies/${id}/whatif-batches`, { baseVersionId: `${id}-v1`, targetVersionId: `${id}-v3` }),
      idParams(id),
    )),
  whatifBatch: (actor: Actor, id: string) =>
    (as(actor),
    whatifBatchRoute.GET(jsonRequest('GET', `/api/v1/policies/${id}/whatif-batches/b-1`), {
      params: Promise.resolve({ id, batchId: 'b-1' }),
    })),
  evidence: (actor: Actor, policyId?: string) =>
    (as(actor), reportsRoute.POST(jsonRequest('POST', '/api/reports', { policyId, dryRun: true }))),
  teamList: (actor: Actor) =>
    (as(actor), teamPoliciesRoute.GET(jsonRequest('GET', `/api/teams/${TEAM}/policies`), { params: Promise.resolve({ teamId: TEAM }) })),
  myList: (actor: Actor) => (as(actor), policiesRoute.GET()),
  trashList: (actor: Actor) => (as(actor), trashRoute.GET()),
  v1List: (key: string) => (as(null), v1ListRoute.GET(jsonRequest('GET', '/api/v1/policies', undefined, { authorization: `Bearer ${key}` }))),
  v1Execute: (key: string, id: string) =>
    (as(null),
    v1ExecuteRoute.POST(
      jsonRequest('POST', `/api/v1/policies/${id}/execute`, { input: { x: 1 }, functionName: 'r' }, { authorization: `Bearer ${key}` }),
      idParams(id),
    )),
};

async function statusOf(res: Promise<Response> | Response): Promise<number> {
  return (await res).status;
}

async function bodyOf<T = Record<string, unknown>>(res: Promise<Response> | Response): Promise<T> {
  return (await (await res).json()) as T;
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('团队策略授权矩阵（真实 Postgres）', () => {
  const previous = globalForDb.__asterLocalDevDb;
  const db = createDb(undefined, { max: 4 });

  beforeAll(async () => {
    globalForDb.__asterLocalDevDb = db;
    await cleanup(db);
  }, 120_000);

  // 本机负载高时夹具重建可能超过默认 10s 钩子超时，超时后半途的数据会让下一个用例主键冲突
  beforeEach(async () => {
    await cleanup(db);
    await seed(db);
  }, 120_000);

  afterAll(async () => {
    await cleanup(db);
    globalForDb.__asterLocalDevDb = previous;
    await db.$client.end({ timeout: 1 });
  }, 120_000);

  // ── 查看类：所有团队成员可看他人创建的团队策略；团队外用户与被移除的创建者 404（#669 #670）──
  describe('查看（view）', () => {
    const allowed: Actor[] = ['owner', 'admin', 'member', 'viewer'];
    const denied: Actor[] = ['outsider', 'ex'];

    for (const [name, fn, ok] of [
      ['详情 GET /api/policies/:id', call.get, 200],
      ['执行日志 /logs', call.logs, 200],
      ['最近执行 /logs?mode=recent', call.logsRecent, 200],
      ['执行统计 /logs?mode=stats', call.logsStats, 200],
      ['条件漏斗 /funnel', call.funnel, 200],
      ['What-If 估算占位 /whatif（409 REPLAY_REQUIRED 表示已过授权）', call.whatifStub, 409],
      ['版本列表 GET /api/v1/policies/:id/versions', call.versions, 200],
    ] as const) {
      it(`${name}：成员 ${ok}，团队外 / 被移除 404`, async () => {
        for (const actor of allowed) expect(await statusOf(fn(actor, POL.mem)), `${actor}`).toBe(ok);
        for (const actor of denied) expect(await statusOf(fn(actor, POL.mem)), `${actor}`).toBe(404);
      });
    }

    it('版本详情：viewer 可读他人创建的团队策略版本，团队外 404', async () => {
      expect(await statusOf(call.versionDetail('viewer', POL.own, 1))).toBe(200);
      expect(await statusOf(call.versionDetail('outsider', POL.own, 1))).toBe(404);
    });

    it('Cedar 导出：成员通过授权（无已批准版本时 409），团队外 404', async () => {
      expect(await statusOf(call.cedar('member', POL.mem))).toBe(409);
      expect(await statusOf(call.cedar('outsider', POL.mem))).toBe(404);
    });

    it('被移除的创建者对自己创建的团队策略：查看、日志、版本一律 404（#670）', async () => {
      expect(await statusOf(call.get('ex', POL.ex))).toBe(404);
      expect(await statusOf(call.logs('ex', POL.ex))).toBe(404);
      expect(await statusOf(call.versions('ex', POL.ex))).toBe(404);
      expect(await statusOf(call.versionDetail('ex', POL.ex, 1))).toBe(404);
      expect(await statusOf(call.whatifStub('ex', POL.ex))).toBe(404);
    });

    it('个人策略只给所有者：团队成员 404', async () => {
      expect(await statusOf(call.get('owner', POL.personal))).toBe(200);
      for (const actor of ['admin', 'member', 'viewer', 'outsider'] as const) {
        expect(await statusOf(call.get(actor, POL.personal)), actor).toBe(404);
      }
    });
  });

  // ── 执行：owner/admin/member 可执行他人创建的团队策略；viewer 403（含自己创建的）──
  describe('执行（execute）', () => {
    it('会话执行矩阵', async () => {
      for (const actor of ['owner', 'admin', 'member'] as const) {
        expect(await statusOf(call.execute(actor, POL.own)), actor).toBe(200);
      }
      expect(await statusOf(call.execute('viewer', POL.own))).toBe(403);
      expect(await statusOf(call.execute('outsider', POL.own))).toBe(404);
    });

    it('被降为 viewer 的创建者不能执行自己创建的团队策略（#670）', async () => {
      const res = await call.execute('viewer', POL.view);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'insufficient_team_role' });
    });

    it('被移除的创建者不能执行自己创建的团队策略（#670）', async () => {
      expect(await statusOf(call.execute('ex', POL.ex))).toBe(404);
    });
  });

  // ── 编辑 / 提交审批：member 起可写；viewer 403；被移除 404 ──
  describe('编辑（update）', () => {
    it('PUT 编辑他人创建的团队策略（#669）', async () => {
      for (const actor of ['owner', 'admin', 'member'] as const) {
        expect(await statusOf(call.put(actor, POL.own)), actor).toBe(200);
      }
      const [row] = await db.select({ description: policies.description }).from(policies).where(eq(policies.id, POL.own));
      expect(row.description).toBe('edited by member');
      expect(await statusOf(call.put('viewer', POL.own))).toBe(403);
      expect(await statusOf(call.put('outsider', POL.own))).toBe(404);
    });

    it('viewer 不能编辑自己创建的团队策略，被移除的创建者也不能（#670）', async () => {
      expect(await statusOf(call.put('viewer', POL.view))).toBe(403);
      expect(await statusOf(call.put('ex', POL.ex))).toBe(404);
      const [row] = await db.select({ description: policies.description }).from(policies).where(eq(policies.id, POL.ex));
      expect(row.description).toBeNull();
    });

    it('新建版本：viewer 403、团队外 404（授权先于编译门禁）', async () => {
      expect(await statusOf(call.createVersion('viewer', POL.own))).toBe(403);
      expect(await statusOf(call.createVersion('outsider', POL.own))).toBe(404);
      expect(await statusOf(call.createVersion('ex', POL.ex))).toBe(404);
    });

    it('提交审批：成员可提交他人创建的版本；viewer 403；被移除 404（#670）', async () => {
      expect(await statusOf(call.submit('member', POL.own, 1))).toBe(200);
      expect(await statusOf(call.submit('viewer', POL.view, 1))).toBe(403);
      expect(await statusOf(call.submit('ex', POL.ex, 1))).toBe(404);
      expect(await statusOf(call.submit('outsider', POL.own, 1))).toBe(404);
      const [ex] = await db.select({ status: policyVersions.status }).from(policyVersions).where(eq(policyVersions.id, `${POL.ex}-v1`));
      expect(ex.status).toBe('DRAFT');
    });

    it('设默认版本：member 可、viewer 403', async () => {
      expect(await statusOf(call.setDefault('member', POL.own, 3))).toBe(200);
      expect(await statusOf(call.setDefault('viewer', POL.own, 3))).toBe(403);
    });
  });

  // ── 删除 / 恢复 / 永久删除 / 归档：owner/admin；member（含创建者）403 ──
  describe('删除（delete）', () => {
    it('删除他人创建的团队策略：admin 可（#669）', async () => {
      expect(await statusOf(call.del('admin', POL.mem))).toBe(200);
    });

    it('member 不能删除自己创建的团队策略，viewer 也不能（#670）', async () => {
      const member = await call.del('member', POL.mem);
      expect(member.status).toBe(403);
      expect(await member.json()).toMatchObject({ code: 'insufficient_team_role' });
      expect(await statusOf(call.del('viewer', POL.view))).toBe(403);
      expect(await statusOf(call.del('outsider', POL.mem))).toBe(404);
      expect(await statusOf(call.del('ex', POL.ex))).toBe(404);
    });

    it('恢复：admin 可恢复 owner 删除的团队策略；member 403；团队外 404', async () => {
      expect(await statusOf(call.restore('member', POL.deleted))).toBe(403);
      expect(await statusOf(call.restore('outsider', POL.deleted))).toBe(404);
      expect(await statusOf(call.restore('admin', POL.deleted))).toBe(200);
      const [row] = await db.select({ deletedAt: policies.deletedAt, teamId: policies.teamId }).from(policies).where(eq(policies.id, POL.deleted));
      expect(row).toEqual({ deletedAt: null, teamId: TEAM });
    });

    it('永久删除：member 403；owner 可', async () => {
      expect(await statusOf(call.purge('member', POL.deleted))).toBe(403);
      expect(await statusOf(call.purge('owner', POL.deleted))).toBe(200);
    });

    it('回收站列表：团队 owner/admin 看得到团队策略，member 与团队外看不到', async () => {
      const ids = async (actor: Actor) =>
        (await bodyOf<{ items: Array<{ policyId: string }> }>(call.trashList(actor))).items.map((i) => i.policyId);
      expect(await ids('admin')).toContain(POL.deleted);
      expect(await ids('member')).not.toContain(POL.deleted);
      expect(await ids('outsider')).not.toContain(POL.deleted);
    });

    it('归档版本：member 403、admin 可', async () => {
      expect(await statusOf(call.archive('member', POL.own, 3))).toBe(403);
      expect(await statusOf(call.archive('admin', POL.own, 3))).toBe(200);
    });
  });

  // ── 审批：owner/admin，且不是版本作者（四眼）──
  describe('审批（approve）', () => {
    it('驳回 member 提交的版本：owner/admin 可；member 403；团队外 404', async () => {
      expect(await statusOf(call.reject('member', POL.mem, 1))).toBe(403);
      expect(await statusOf(call.reject('viewer', POL.mem, 1))).toBe(403);
      expect(await statusOf(call.reject('outsider', POL.mem, 1))).toBe(404);
      expect(await statusOf(call.reject('admin', POL.mem, 1))).toBe(200);
    });

    it('admin 不能驳回自己作为作者的版本（四眼）', async () => {
      const res = await call.reject('admin', POL.own, 2);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'segregation_of_duties' });
      expect(await statusOf(call.reject('owner', POL.own, 2))).toBe(200);
    });
  });

  // ── What-If：ADR 0034 §4.3 属主限定 ──
  describe('What-If（whatif）', () => {
    it('创建者可发起；其他成员 403 whatif_owner_only；团队外 404', async () => {
      expect(await statusOf(call.whatif('owner', POL.own))).toBe(202);
      const admin = await call.whatif('admin', POL.own);
      expect(admin.status).toBe(403);
      expect(await admin.json()).toMatchObject({ error: 'whatif_owner_only' });
      expect(await statusOf(call.whatif('outsider', POL.own))).toBe(404);
      expect(await statusOf(call.whatifBatch('outsider', POL.own))).toBe(404);
      expect(await statusOf(call.whatifBatch('owner', POL.own))).toBe(200);
    });

    it('被移除 / 降为 viewer 的创建者不能再发起（#670）', async () => {
      expect(await statusOf(call.whatif('ex', POL.ex))).toBe(404);
      expect(await statusOf(call.whatif('viewer', POL.view))).toBe(403);
    });
  });

  // ── 日志与证据覆盖团队策略的全部执行（#673）──
  describe('日志与证据（#673）', () => {
    it('任一成员看到的日志都包含全部成员的执行', async () => {
      for (const actor of ['owner', 'member', 'viewer'] as const) {
        const body = await bodyOf<{ total: number; items: Array<{ id: string }> }>(call.logs(actor, POL.own));
        expect(body.total, actor).toBe(3);
      }
      const recent = await bodyOf<{ items: unknown[] }>(call.logsRecent('owner', POL.mem));
      expect(recent.items).toHaveLength(2);
      const stats = await bodyOf<{ stats: { totalExecutions: number } }>(call.logsStats('admin', POL.own));
      expect(stats.stats.totalExecutions).toBe(3);
      const funnel = await bodyOf<{ sampleSize: number }>(call.funnel('admin', POL.own));
      expect(funnel.sampleSize).toBe(3);
    });

    it('个人策略日志仍只含所有者本人的执行', async () => {
      const body = await bodyOf<{ total: number }>(call.logs('owner', POL.personal));
      expect(body.total).toBe(1);
    });

    it('证据预览：团队策略含全部成员的执行；团队外 404', async () => {
      expect((await bodyOf<{ count: number }>(call.evidence('owner', POL.own))).count).toBe(3);
      expect((await bodyOf<{ count: number }>(call.evidence('owner', POL.mem))).count).toBe(2);
      expect((await bodyOf<{ count: number }>(call.evidence('admin', POL.mem))).count).toBe(2);
      expect(await statusOf(call.evidence('outsider', POL.mem))).toBe(404);
      expect(await statusOf(call.evidence('ex', POL.ex))).toBe(404);
    });

    it('证据预览（全部策略）：本人个人策略 + 可见团队策略的全部执行', async () => {
      // owner：own 3 + mem 2 + personal 1（ex/view 无执行，deleted 已删除）
      expect((await bodyOf<{ count: number }>(call.evidence('owner'))).count).toBe(6);
      // outsider：没有任何可见执行
      expect((await bodyOf<{ count: number }>(call.evidence('outsider'))).count).toBe(0);
    });
  });

  // ── 列表 ──
  describe('列表（#674 #670）', () => {
    it('团队策略列表不含已删除的策略，且与 policyCount 一致', async () => {
      const body = await bodyOf<{ policies: Array<{ id: string }> }>(call.teamList('viewer'));
      const ids = body.policies.map((p) => p.id).sort();
      expect(ids).toEqual([POL.ex, POL.mem, POL.own, POL.view].sort());
    });

    it('被移除的创建者的「我的策略」不再含团队策略', async () => {
      const ex = await bodyOf<{ policies: Array<{ id: string }> }>(call.myList('ex'));
      expect(ex.policies.map((p) => p.id)).toEqual([]);
      const owner = await bodyOf<{ policies: Array<{ id: string }> }>(call.myList('owner'));
      expect(owner.policies.map((p) => p.id).sort()).toEqual([POL.own, POL.personal].sort());
    });
  });

  // ── 离队 / 移除 / 降级立即生效 ──
  describe('成员关系变化立即生效', () => {
    it('移除成员后下一次请求即 404', async () => {
      expect(await statusOf(call.put('admin', POL.own))).toBe(200);
      await db.delete(teamMembers).where(and(eq(teamMembers.teamId, TEAM), eq(teamMembers.userId, U.admin)));
      expect(await statusOf(call.put('admin', POL.own))).toBe(404);
      expect(await statusOf(call.get('admin', POL.own))).toBe(404);
    });

    it('降级为 viewer 后下一次写请求即 403', async () => {
      expect(await statusOf(call.put('member', POL.mem))).toBe(200);
      await db.update(teamMembers).set({ role: 'viewer' }).where(eq(teamMembers.id, `${P}-tm-member`));
      expect(await statusOf(call.put('member', POL.mem))).toBe(403);
      expect(await statusOf(call.get('member', POL.mem))).toBe(200);
    });
  });

  // ── API v1 与团队 key（#671）──
  describe('API v1 与团队 key（#671）', () => {
    it('团队 key 列表只含该团队的策略', async () => {
      const body = await bodyOf<{ policies: Array<{ id: string; teamId?: string | null }> }>(call.v1List(KEY.ownerTeam));
      const ids = body.policies.map((p) => p.id).sort();
      expect(ids).toEqual([POL.ex, POL.mem, POL.own, POL.view].sort());
      for (const p of body.policies) expect(p.teamId).toBe(TEAM);
    });

    it('个人 key 列表含本人个人策略与所在团队策略', async () => {
      const body = await bodyOf<{ policies: Array<{ id: string }> }>(call.v1List(KEY.ownerPersonal));
      expect(body.policies.map((p) => p.id)).toContain(POL.personal);
      expect(body.policies.map((p) => p.id)).toContain(POL.mem);
    });

    it('团队 key 不能执行创建者的个人策略', async () => {
      expect(await statusOf(call.v1Execute(KEY.ownerTeam, POL.personal))).toBe(404);
      expect(await statusOf(call.v1Execute(KEY.ownerPersonal, POL.personal))).toBe(200);
    });

    it('团队 key 执行本团队策略', async () => {
      expect(await statusOf(call.v1Execute(KEY.ownerTeam, POL.mem))).toBe(200);
      expect(await statusOf(call.v1Execute(KEY.memberTeam, POL.own))).toBe(200);
    });

    it('Free 成员的团队 key 调列表不按成员个人配额拦截', async () => {
      expect(await statusOf(call.v1List(KEY.memberTeam))).toBe(200);
    });
  });
});
