// 团队策略授权矩阵（#669 #670 #671 #673 #674），真实 Postgres + 真实路由处理器。
//
// 每个用例前重建同一组夹具：团队 T（owner / admin / member / viewer），团队外用户 outsider，
// 已被移除的创建者 ex（其创建的团队策略仍留在团队里）。逐路由断言矩阵的每一格，
// 包括越权反例：被移除成员、viewer 写操作、团队 key 访问个人策略、团队外用户。
// 外部依赖（aster-api 执行 / What-If / Cedar、KV 缓存）用替身，授权与数据查询全部走真库。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts team-policy-authz

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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
  auditLogs,
  complianceReports,
  executions,
  policies,
  policyApprovals,
  policyGroups,
  policyRecycleBins,
  policyReviewers,
  policyShares,
  policyVersions,
  securityEvents,
  teamMembers,
  teams,
  notifications,
  usageRecords,
  users,
} from '@/lib/prisma';
import { hashApiKey } from '@/lib/api-keys';
import { createPolicyApiClient } from '@/services/policy/policy-api';
import { invalidatePolicyCache } from '@/lib/cache';
import { PLATFORM_SETTING_KEYS, setSetting } from '@/lib/platform-settings';
import { notifyVersionDecided, notifyVersionSubmitted } from '@/lib/version-notifications';
import * as sharesRoute from '@/app/api/policies/[id]/shares/route';
import * as reviewersRoute from '@/app/api/policies/[id]/reviewers/route';
import * as groupPoliciesRoute from '@/app/api/policy-groups/[id]/policies/route';
import * as teamRoute from '@/app/api/teams/[teamId]/route';
import { getDashboardData } from '@/app/[locale]/(dashboard)/dashboard/dashboard-data';
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
/** 团队外用户 outsider 自己的团队：用来接收分享 */
const TEAM2 = `${P}-team2`;
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
  await db.delete(policyShares).where(inArray(policyShares.policyId, POLICY_IDS));
  await db.delete(auditLogs).where(inArray(auditLogs.userId, USER_IDS));
  await db.delete(notifications).where(inArray(notifications.userId, USER_IDS));
  await db.delete(policyReviewers).where(inArray(policyReviewers.policyId, POLICY_IDS));
  await db.delete(policyGroups).where(inArray(policyGroups.userId, USER_IDS));
  await db.delete(teamMembers).where(eq(teamMembers.teamId, TEAM2));
  await db.delete(teams).where(eq(teams.id, TEAM2));
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

  const exec = (id: string, policyId: string, userId: string, tenantId: string) => ({
    id: `${P}-exec-${id}`,
    policyId,
    userId,
    tenantId,
    input: { x: 1 },
    output: { allowed: true },
    durationMs: 3,
    success: true,
    decision: 'approved' as const,
    source: 'dashboard' as const,
    canonicalInputHash: 'h'.repeat(64),
  });
  await db.insert(executions).values([
    exec('own-1', POL.own, U.owner, TEAM),
    exec('own-2', POL.own, U.owner, TEAM),
    exec('own-3', POL.own, U.member, TEAM),
    exec('mem-1', POL.mem, U.member, TEAM),
    exec('mem-2', POL.mem, U.owner, TEAM),
    exec('personal-1', POL.personal, U.owner, U.owner),
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

  // ── 安全审查后续（cloud#691 审查 H1 / M1 / M2 / M3 / L1 / L3 / L7）──
  describe('What-If 租户（H1）', () => {
    it('团队策略的批次创建与查询都以团队 id 为租户、当前用户为 userId', async () => {
      const mocked = vi.mocked(createPolicyApiClient);
      mocked.mockClear();
      expect(await statusOf(call.whatif('owner', POL.own))).toBe(202);
      expect(await statusOf(call.whatifBatch('owner', POL.own))).toBe(200);
      expect(mocked.mock.calls.map((c) => c.slice(0, 2))).toEqual([[TEAM, U.owner], [TEAM, U.owner]]);
    });

    it('个人策略的批次租户为所有者本人', async () => {
      const mocked = vi.mocked(createPolicyApiClient);
      mocked.mockClear();
      expect(await statusOf(call.whatif('owner', POL.personal))).toBe(202);
      expect(mocked.mock.calls.map((c) => c.slice(0, 2))).toEqual([[U.owner, U.owner]]);
    });
  });

  describe('团队外执行人的原始记录（M1）', () => {
    beforeEach(async () => {
      await db.update(policies).set({ isPublic: true }).where(eq(policies.id, POL.own));
      await db.insert(executions).values({
        id: `${P}-exec-outsider`,
        policyId: POL.own,
        userId: U.outsider,
        tenantId: U.outsider,
        input: { secret: 'outsider-pii' },
        output: { allowed: true },
        durationMs: 3,
        success: true,
        decision: 'approved',
        source: 'dashboard',
        canonicalInputHash: 'h'.repeat(64),
      } as typeof executions.$inferInsert);
    });

    it('团队外用户可经公开授予执行团队策略', async () => {
      expect(await statusOf(call.execute('outsider', POL.own))).toBe(200);
    });

    it('viewer 的日志明细与最近执行不含团队外执行人的记录，统计计入全部执行', async () => {
      const logs = await bodyOf<{ total: number; items: Array<{ id: string }> }>(call.logs('viewer', POL.own));
      expect(logs.items.map((i) => i.id)).not.toContain(`${P}-exec-outsider`);
      expect(logs.total).toBe(3);
      const recent = await bodyOf<{ items: Array<{ id: string }> }>(call.logsRecent('viewer', POL.own));
      expect(recent.items.map((i) => i.id)).not.toContain(`${P}-exec-outsider`);
      const stats = await bodyOf<{ stats: { totalExecutions: number } }>(call.logsStats('viewer', POL.own));
      expect(stats.stats.totalExecutions).toBe(4);
    });

    it('证据导出不含团队外执行人的记录', async () => {
      expect((await bodyOf<{ count: number }>(call.evidence('owner', POL.own))).count).toBe(3);
      expect((await bodyOf<{ count: number }>(call.evidence('owner'))).count).toBe(6);
    });

    // #698：按执行时所属租户过滤——离队成员的历史留在团队审计里，团队外执行人的记录仍不进入
    it('离队成员留下的历史执行仍在日志、最近执行与证据导出里', async () => {
      await db.delete(teamMembers).where(and(eq(teamMembers.teamId, TEAM), eq(teamMembers.userId, U.member)));
      const logs = await bodyOf<{ total: number; items: Array<{ id: string }> }>(call.logs('owner', POL.own));
      expect(logs.total).toBe(3);
      expect(logs.items.map((i) => i.id)).toContain(`${P}-exec-own-3`);
      expect(logs.items.map((i) => i.id)).not.toContain(`${P}-exec-outsider`);
      const recent = await bodyOf<{ items: Array<{ id: string }> }>(call.logsRecent('owner', POL.own));
      expect(recent.items.map((i) => i.id)).toContain(`${P}-exec-own-3`);
      expect((await bodyOf<{ count: number }>(call.evidence('owner', POL.own))).count).toBe(3);
      expect((await bodyOf<{ count: number }>(call.evidence('owner'))).count).toBe(6);
    });

    it('同一时间窗的证据数量不随成员变动而变', async () => {
      const before = (await bodyOf<{ count: number }>(call.evidence('admin', POL.mem))).count;
      await db.delete(teamMembers).where(and(eq(teamMembers.teamId, TEAM), eq(teamMembers.userId, U.member)));
      expect((await bodyOf<{ count: number }>(call.evidence('admin', POL.mem))).count).toBe(before);
    });

    it('迁移前写入的行（tenantId 为空）回退到按现任成员判定', async () => {
      await db.update(executions).set({ tenantId: null }).where(inArray(executions.id, [`${P}-exec-own-3`, `${P}-exec-outsider`]));
      const logs = await bodyOf<{ items: Array<{ id: string }> }>(call.logs('owner', POL.own));
      const ids = logs.items.map((i) => i.id);
      expect(ids).toContain(`${P}-exec-own-3`);
      expect(ids).not.toContain(`${P}-exec-outsider`);
      expect((await bodyOf<{ count: number }>(call.evidence('owner', POL.own))).count).toBe(3);
    });
  });

  describe('执行记录落库时写入租户（#698）', () => {
    const tenantOfNewest = async (policyId: string, userId: string) => {
      for (let i = 0; i < 50; i++) {
        const rows = await db
          .select({ tenantId: executions.tenantId })
          .from(executions)
          .where(and(eq(executions.policyId, policyId), eq(executions.userId, userId), sql`${executions.id} NOT LIKE ${`${P}-exec-%`}`));
        if (rows.length > 0) return rows.map((r) => r.tenantId);
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error('execution row not written');
    };

    it('团队成员会话执行团队策略 → 团队；viewer 经公开执行也记为团队', async () => {
      expect(await statusOf(call.execute('member', POL.own))).toBe(200);
      expect(await tenantOfNewest(POL.own, U.member)).toEqual([TEAM]);
      await db.update(policies).set({ isPublic: true }).where(eq(policies.id, POL.view));
      expect(await statusOf(call.execute('viewer', POL.view))).toBe(200);
      expect(await tenantOfNewest(POL.view, U.viewer)).toEqual([TEAM]);
    });

    it('团队外用户经公开执行团队策略 → 执行人自己的租户', async () => {
      await db.update(policies).set({ isPublic: true }).where(eq(policies.id, POL.own));
      expect(await statusOf(call.execute('outsider', POL.own))).toBe(200);
      expect(await tenantOfNewest(POL.own, U.outsider)).toEqual([U.outsider]);
    });

    it('个人策略所有者执行 → 本人；团队 key 执行团队策略 → 团队', async () => {
      expect(await statusOf(call.execute('owner', POL.personal))).toBe(200);
      expect(await tenantOfNewest(POL.personal, U.owner)).toEqual([U.owner]);
      expect(await statusOf(call.v1Execute(KEY.memberTeam, POL.own))).toBe(200);
      expect(await tenantOfNewest(POL.own, U.member)).toEqual([TEAM]);
    });
  });

  describe('历史执行记录的租户回填（#698 迁移）', () => {
    // 直接执行迁移文件里的回填语句，保证测的就是上线的 SQL
    const backfill = async () => {
      const file = readFileSync(path.resolve(__dirname, '../../../drizzle/0064_execution_tenant.sql'), 'utf8');
      for (const stmt of file.split('--> statement-breakpoint').map((x) => x.trim()).filter(Boolean)) {
        await db.execute(sql.raw(stmt));
      }
    };
    const tenantOf = async (id: string) =>
      (await db.select({ tenantId: executions.tenantId }).from(executions).where(eq(executions.id, id)))[0].tenantId;
    const raw = (id: string, policyId: string, userId: string, createdAt: Date, apiKeyId: string | null = null) => ({
      id: `${P}-exec-bf-${id}`,
      policyId,
      userId,
      apiKeyId,
      input: {},
      output: {},
      durationMs: 1,
      success: true,
      source: 'dashboard' as const,
      createdAt,
    });

    it('按可证明的成员关系回填；其余记为执行人自己的租户；重复执行幂等', async () => {
      const now = Date.now();
      const longAgo = new Date(now - 86_400_000 * 30);
      await db.update(policies).set({ createdAt: new Date(now - 86_400_000 * 60) }).where(inArray(policies.id, [POL.own, POL.ex]));
      await db.update(teamMembers).set({ createdAt: new Date(now - 86_400_000 * 10) }).where(and(eq(teamMembers.teamId, TEAM), eq(teamMembers.userId, U.admin)));
      await db.insert(executions).values([
        raw('member', POL.own, U.member, new Date(now - 1000)), // 现任成员，入队早于执行
        raw('admin-before-join', POL.own, U.admin, longAgo), // 入队前执行：团队外
        raw('ex-creator', POL.ex, U.ex, longAgo), // 已离队的创建者，期间无移出记录
        raw('outsider', POL.own, U.outsider, new Date(now - 1000)), // 团队外
        raw('team-key', POL.own, U.outsider, new Date(now - 1000), `${P}-key-member-team`), // 团队 key
        raw('personal', POL.personal, U.owner, new Date(now - 1000)),
        raw('personal-key', POL.personal, U.owner, new Date(now - 1000), `${P}-key-owner-team`),
      ] as Array<typeof executions.$inferInsert>);

      await backfill();
      expect(await tenantOf(`${P}-exec-bf-member`)).toBe(TEAM);
      expect(await tenantOf(`${P}-exec-bf-admin-before-join`)).toBe(U.admin);
      expect(await tenantOf(`${P}-exec-bf-ex-creator`)).toBe(TEAM);
      expect(await tenantOf(`${P}-exec-bf-outsider`)).toBe(U.outsider);
      expect(await tenantOf(`${P}-exec-bf-team-key`)).toBe(TEAM);
      expect(await tenantOf(`${P}-exec-bf-personal`)).toBe(U.owner);
      expect(await tenantOf(`${P}-exec-bf-personal-key`)).toBe(TEAM);
      // 已有值不被覆盖
      expect(await tenantOf(`${P}-exec-own-3`)).toBe(TEAM);

      await db.update(executions).set({ tenantId: 'manual' }).where(eq(executions.id, `${P}-exec-bf-outsider`));
      await backfill();
      expect(await tenantOf(`${P}-exec-bf-outsider`)).toBe('manual');
    });

    it('创建者在执行前被移出过团队：不按创建者推断', async () => {
      const now = Date.now();
      await db.update(policies).set({ createdAt: new Date(now - 86_400_000 * 60) }).where(eq(policies.id, POL.ex));
      await db.insert(securityEvents).values({
        id: `${P}-se-removed-ex`,
        eventType: 'VERSION_CREATED',
        severity: 'INFO',
        userId: U.owner,
        details: { action: 'TEAM_MEMBER_REMOVED', teamId: TEAM, removedUserId: U.ex },
        createdAt: new Date(now - 86_400_000 * 20),
      } as typeof securityEvents.$inferInsert);
      await db.insert(executions).values([
        raw('ex-before-removal', POL.ex, U.ex, new Date(now - 86_400_000 * 30)),
        raw('ex-after-removal', POL.ex, U.ex, new Date(now - 86_400_000 * 5)),
      ] as Array<typeof executions.$inferInsert>);
      await backfill();
      expect(await tenantOf(`${P}-exec-bf-ex-before-removal`)).toBe(TEAM);
      expect(await tenantOf(`${P}-exec-bf-ex-after-removal`)).toBe(U.ex);
    });
  });

  describe('公开状态切换（M2）', () => {
    const putPublic = (actor: Actor, id: string, isPublic: boolean) =>
      (as(actor), policyRoute.PUT(jsonRequest('PUT', `/api/policies/${id}`, { isPublic }), idParams(id)));

    it('member 不能把团队策略设为公开（含自己创建的），但仍能做普通编辑', async () => {
      const res = await putPublic('member', POL.mem, true);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'insufficient_team_role' });
      expect(await statusOf(call.put('member', POL.mem))).toBe(200);
      const [row] = await db.select({ isPublic: policies.isPublic }).from(policies).where(eq(policies.id, POL.mem));
      expect(row.isPublic).toBe(false);
    });

    it('admin 可以切换公开状态；值不变的 isPublic 不触发检查', async () => {
      expect(await statusOf(putPublic('admin', POL.mem, true))).toBe(200);
      expect(await statusOf(putPublic('member', POL.mem, true))).toBe(200);
    });

    it('member 不能直接以公开状态创建团队策略', async () => {
      as('member');
      const res = await policiesRoute.POST(
        jsonRequest('POST', '/api/policies', { name: 'x', content: SOURCE, teamId: TEAM, isPublic: true }),
      );
      expect(res.status).toBe(403);
    });
  });

  describe('分享与复核人（L7）', () => {
    beforeEach(async () => {
      await db.insert(teams).values({ id: TEAM2, name: 'Other Team', slug: TEAM2, ownerId: U.outsider });
      await db.insert(teamMembers).values({ id: `${P}-tm2-outsider`, teamId: TEAM2, userId: U.outsider, role: 'owner' });
      await setSetting(PLATFORM_SETTING_KEYS.POLICY_SHARING_ENABLED, true, U.owner);
    });
    afterEach(async () => {
      await setSetting(PLATFORM_SETTING_KEYS.POLICY_SHARING_ENABLED, false, U.owner);
    });

    const shareReq = (actor: Actor, id: string, body: unknown) =>
      (as(actor), sharesRoute.POST(jsonRequest('POST', `/api/policies/${id}/shares`, body), idParams(id)));

    it('member 可分享他人创建的团队策略；viewer 与团队外 404', async () => {
      expect(await statusOf(shareReq('viewer', POL.own, { teamId: TEAM2, permission: 'execute' }))).toBe(404);
      expect(await statusOf(shareReq('ex', POL.ex, { teamId: TEAM2, permission: 'execute' }))).toBe(404);
      expect(await statusOf(shareReq('member', POL.own, { teamId: TEAM2, permission: 'execute' }))).toBe(200);
      as('member');
      expect((await sharesRoute.GET(jsonRequest('GET', `/api/policies/${POL.own}/shares`), idParams(POL.own))).status).toBe(200);
    });

    it('分享授予：被分享团队的成员可读、可执行；只读分享执行 403', async () => {
      expect(await statusOf(call.get('outsider', POL.mem))).toBe(404);
      expect(await statusOf(shareReq('owner', POL.mem, { teamId: TEAM2, permission: 'view' }))).toBe(200);
      expect(await statusOf(call.get('outsider', POL.mem))).toBe(200);
      const viewOnly = await call.execute('outsider', POL.mem);
      expect(viewOnly.status).toBe(403);
      expect(await viewOnly.json()).toMatchObject({ code: 'share_view_only' });
      await db.update(policyShares).set({ permission: 'execute' }).where(eq(policyShares.policyId, POL.mem));
      expect(await statusOf(call.execute('outsider', POL.mem))).toBe(200);
    });

    it('公开 + 分享叠加：公开优先放行执行，分享仍可读', async () => {
      await db.update(policies).set({ isPublic: true }).where(eq(policies.id, POL.mem));
      expect(await statusOf(shareReq('owner', POL.mem, { teamId: TEAM2, permission: 'view' }))).toBe(200);
      expect(await statusOf(call.get('outsider', POL.mem))).toBe(200);
      expect(await statusOf(call.execute('outsider', POL.mem))).toBe(200);
    });

    it('复核人管理：member 起可看，viewer / 团队外 / 已离队 404', async () => {
      const reviewers = (actor: Actor, id: string) =>
        (as(actor), reviewersRoute.GET(jsonRequest('GET', `/api/policies/${id}/reviewers`), idParams(id)));
      expect(await statusOf(reviewers('member', POL.own))).toBe(200);
      expect(await statusOf(reviewers('viewer', POL.own))).toBe(404);
      expect(await statusOf(reviewers('outsider', POL.own))).toBe(404);
      expect(await statusOf(reviewers('ex', POL.ex))).toBe(404);
    });
  });

  describe('团队 key 与公开策略（L7）', () => {
    it('团队 key 不能借公开策略越出团队（个人 key 可以）', async () => {
      await db.update(policies).set({ isPublic: true }).where(eq(policies.id, POL.personal));
      expect(await statusOf(call.v1Execute(KEY.memberTeam, POL.personal))).toBe(404);
    });
  });

  describe('清空回收站（M3）', () => {
    it('只清空本人删除的条目；他人删除的团队条目保留，需逐条永久删除', async () => {
      expect(await statusOf(call.del('admin', POL.mem))).toBe(200);
      as('admin');
      const res = await trashRoute.DELETE();
      expect(res.status).toBe(200);
      const left = await db.select({ id: policies.id }).from(policies).where(inArray(policies.id, [POL.mem, POL.deleted]));
      expect(left.map((r) => r.id)).toEqual([POL.deleted]);
      expect(await statusOf(call.purge('admin', POL.deleted))).toBe(200);
    });

    it('member 清空回收站不会删除任何团队条目', async () => {
      as('member');
      await trashRoute.DELETE();
      const [row] = await db.select({ id: policies.id }).from(policies).where(eq(policies.id, POL.deleted));
      expect(row?.id).toBe(POL.deleted);
    });
  });

  describe('离队者的残留可见性与分组（L1）', () => {
    it('离队者的仪表盘不再列出其创建的团队策略', async () => {
      const data = await getDashboardData(U.ex);
      expect(JSON.stringify(data)).not.toContain(POL.ex);
    });

    it('团队策略只能放进同一团队的分组，创建者也不例外（#699 A）', async () => {
      await db.insert(policyGroups).values([
        { id: `${P}-grp-member`, userId: U.member, name: 'mine', updatedAt: new Date() },
        { id: `${P}-grp-team`, userId: U.owner, teamId: TEAM, name: 'team', updatedAt: new Date() },
      ] as Array<typeof policyGroups.$inferInsert>);
      const move = (id: string, groupId = `${P}-grp-member`) =>
        (as('member'),
        groupPoliciesRoute.POST(jsonRequest('POST', `/api/policy-groups/${groupId}/policies`, { policyIds: [id] }), {
          params: Promise.resolve({ id: groupId }),
        }));
      expect(await statusOf(move(POL.own))).toBe(404);
      // 自己创建的团队策略同样不能挪进个人私有分组
      expect(await statusOf(move(POL.mem))).toBe(404);
      expect(await statusOf(move(POL.mem, `${P}-grp-team`))).toBe(200);
      expect(await statusOf(move(POL.own, `${P}-grp-team`))).toBe(200);
      const viaPutOwn = (as('member'), policyRoute.PUT(jsonRequest('PUT', `/api/policies/${POL.mem}`, { groupId: `${P}-grp-member` }), idParams(POL.mem)));
      expect(await statusOf(viaPutOwn)).toBe(404);
      const placed = await db.select({ id: policies.id, groupId: policies.groupId }).from(policies).where(inArray(policies.id, [POL.own, POL.mem]));
      expect(placed.every((r) => r.groupId === `${P}-grp-team`)).toBe(true);
      await db.update(policies).set({ groupId: null }).where(inArray(policies.id, [POL.own, POL.mem]));
      const viaPut = (as('member'), policyRoute.PUT(jsonRequest('PUT', `/api/policies/${POL.own}`, { groupId: `${P}-grp-member` }), idParams(POL.own)));
      expect(await statusOf(viaPut)).toBe(404);
      const [row] = await db.select({ groupId: policies.groupId }).from(policies).where(eq(policies.id, POL.own));
      expect(row.groupId).toBeNull();
    });
  });

  describe('分组批量放置（#699 A / C）', () => {
    const batch = (actor: Actor, groupId: string, policyIds: unknown, method: 'POST' | 'DELETE' = 'POST') =>
      (as(actor),
      groupPoliciesRoute[method](jsonRequest(method, `/api/policy-groups/${groupId}/policies`, { policyIds }), {
        params: Promise.resolve({ id: groupId }),
      }));

    beforeEach(async () => {
      await db.insert(policyGroups).values([
        { id: `${P}-grp-owner`, userId: U.owner, name: 'owner private', updatedAt: new Date() },
        { id: `${P}-grp-team`, userId: U.owner, teamId: TEAM, name: 'team', updatedAt: new Date() },
      ] as Array<typeof policyGroups.$inferInsert>);
    });

    it('个人策略所有者仍可把个人策略放进自己的私有分组', async () => {
      expect(await statusOf(batch('owner', `${P}-grp-owner`, [POL.personal]))).toBe(200);
      const [row] = await db.select({ groupId: policies.groupId }).from(policies).where(eq(policies.id, POL.personal));
      expect(row.groupId).toBe(`${P}-grp-owner`);
    });

    it('一批里混有不可放置的策略：整批 404，一条都不写', async () => {
      expect(await statusOf(batch('owner', `${P}-grp-owner`, [POL.personal, POL.own]))).toBe(404);
      const rows = await db.select({ groupId: policies.groupId }).from(policies).where(inArray(policies.id, [POL.personal, POL.own]));
      expect(rows.every((r) => r.groupId === null)).toBe(true);
    });

    it('多条团队策略一次放入同一团队分组，再一次移出；viewer 不能移出', async () => {
      const ids = [POL.own, POL.mem, POL.view];
      expect(await statusOf(batch('member', `${P}-grp-team`, ids))).toBe(200);
      expect(await statusOf(batch('viewer', `${P}-grp-team`, ids, 'DELETE'))).toBe(200);
      let rows = await db.select({ groupId: policies.groupId }).from(policies).where(inArray(policies.id, ids));
      expect(rows.every((r) => r.groupId === `${P}-grp-team`)).toBe(true);
      expect(await statusOf(batch('admin', `${P}-grp-team`, ids, 'DELETE'))).toBe(200);
      rows = await db.select({ groupId: policies.groupId }).from(policies).where(inArray(policies.id, ids));
      expect(rows.every((r) => r.groupId === null)).toBe(true);
    });

    it('policyIds 超过 100 条或不是字符串数组：400', async () => {
      const tooMany = Array.from({ length: 101 }, (_, i) => `${P}-x-${i}`);
      expect(await statusOf(batch('owner', `${P}-grp-team`, tooMany))).toBe(400);
      expect(await statusOf(batch('owner', `${P}-grp-team`, tooMany, 'DELETE'))).toBe(400);
      expect(await statusOf(batch('owner', `${P}-grp-team`, [1, 2]))).toBe(400);
    });
  });

  describe('导入个人策略到团队（#699 B）', () => {
    const importPolicy = (actor: Actor, policyId: string) =>
      (as(actor),
      teamPoliciesRoute.POST(jsonRequest('POST', `/api/teams/${TEAM}/policies`, { policyId }), {
        params: Promise.resolve({ teamId: TEAM }),
      }));

    it('导入已公开的个人策略：成为团队策略，公开状态重置为 false', async () => {
      await db.update(policies).set({ userId: U.member, isPublic: true }).where(eq(policies.id, POL.personal));
      const res = await importPolicy('member', POL.personal);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: POL.personal, teamId: TEAM, isPublic: false });
      const [row] = await db.select({ teamId: policies.teamId, isPublic: policies.isPublic }).from(policies).where(eq(policies.id, POL.personal));
      expect(row).toEqual({ teamId: TEAM, isPublic: false });
    });
  });

  describe('版本驳回理由与审批通知的可见性（#701）', () => {
    const rejectedComment = 'internal: pricing too aggressive';
    async function rejectOwnV1(): Promise<void> {
      // POL.own 的 v1 由 owner 创建；改为已驳回并留下驳回意见
      await db.update(policyVersions).set({ status: 'REJECTED' }).where(eq(policyVersions.id, `${POL.own}-v1`));
      await db.insert(policyApprovals).values({
        id: `${P}-appr-own-v1`, versionId: `${POL.own}-v1`, approverId: U.admin, decision: 'REJECTED', comment: rejectedComment,
      });
    }

    it('版本列表：团队成员看得到驳回理由，经公开放行的团队外用户看不到', async () => {
      await rejectOwnV1();
      await db.update(policies).set({ isPublic: true }).where(eq(policies.id, POL.own));
      const forViewer = await bodyOf<{ versions: Array<{ version: number; rejectionComment?: string | null }> }>(call.versions('viewer', POL.own));
      expect(forViewer.versions.find((v) => v.version === 1)?.rejectionComment).toBe(rejectedComment);
      const outsiderRes = await call.versions('outsider', POL.own);
      expect(outsiderRes.status).toBe(200);
      const text = await outsiderRes.text();
      expect(text).not.toContain(rejectedComment);
      const forOutsider = JSON.parse(text) as { versions: Array<Record<string, unknown>> };
      expect(forOutsider.versions.length).toBeGreaterThan(0);
      expect(forOutsider.versions.every((v) => !('rejectionComment' in v))).toBe(true);
    });

    it('审批结论：作者已离队时不发通知；仍在队时照常通知', async () => {
      await notifyVersionDecided({ policyId: POL.ex, version: 1, reviewerId: U.owner, outcome: 'REJECTED', comment: rejectedComment });
      expect(await db.select().from(notifications).where(eq(notifications.userId, U.ex))).toHaveLength(0);
      await notifyVersionDecided({ policyId: POL.mem, version: 1, reviewerId: U.owner, outcome: 'REJECTED', comment: 'no' });
      expect(await db.select().from(notifications).where(eq(notifications.userId, U.member))).toHaveLength(1);
    });

    it('提交审批：不通知提交者，也不通知版本作者本人（#701 D）', async () => {
      // POL.own 的 v2 由 admin 创建，由 member 提交：只通知 owner
      await notifyVersionSubmitted({ policyId: POL.own, version: 2, submitterId: U.member });
      const rows = await db.select({ userId: notifications.userId }).from(notifications)
        .where(and(inArray(notifications.userId, USER_IDS), eq(notifications.kind, 'policy.version_submitted')));
      expect(rows.map((r) => r.userId)).toEqual([U.owner]);
    });
  });

  describe('删除团队后失效策略元数据缓存（L3）', () => {
    it('团队删除时对其全部策略失效执行路径缓存', async () => {
      const mocked = vi.mocked(invalidatePolicyCache);
      mocked.mockClear();
      as('owner');
      const res = await teamRoute.DELETE(jsonRequest('DELETE', `/api/teams/${TEAM}`), { params: Promise.resolve({ teamId: TEAM }) });
      expect(res.status).toBe(200);
      const invalidated = mocked.mock.calls.map((c) => c[0]).sort();
      expect(invalidated).toEqual([POL.deleted, POL.ex, POL.mem, POL.own, POL.view].sort());
    });
  });
});
