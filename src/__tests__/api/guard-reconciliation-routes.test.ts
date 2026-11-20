// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Guard 对账 BFF（ADR 0061 §3.1–§3.4，计划 T3/T4）。访问判定与客户端工厂用真实实现（只替换成员关系查询与
 * 客户端构造），上游用按 id 降序分页的内存表模拟：`legacy` 模式忽略 severity（旧 aster-api），否则按 severity 过滤。
 */

vi.mock('server-only', () => ({}));

const h = vi.hoisted(() => ({
  getSession: vi.fn(),
  roles: new Map<string, string>(),
  factoryCalls: 0,
  createClient: vi.fn(),
  listCalls: [] as Array<{ before?: number; severities: string[]; limit: number }>,
  table: [] as Array<{ id: number; severity: string; kind: string; status: string; acknowledgedBy?: string }>,
  legacy: false,
  summary: vi.fn(),
  ack: vi.fn(),
  getDecision: vi.fn(),
  profiles: vi.fn(),
  loadDecisionContext: vi.fn(),
  overview: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ getSession: () => h.getSession() }));
vi.mock('@/lib/team-permissions', async () => {
  const matrix = await vi.importActual<typeof import('@/lib/team-permission-matrix')>('@/lib/team-permission-matrix');
  return {
    getRoleLevel: matrix.getRoleLevel,
    ROLE_HIERARCHY: matrix.ROLE_HIERARCHY,
    SOLO_TENANT_ROLE: 'owner',
    getTeamMemberRole: async (userId: string, teamId: string) => h.roles.get(`${userId}:${teamId}`) ?? null,
  };
});
vi.mock('@/lib/policy-api-identity', () => ({
  createPolicyApiClientForUser: (...args: unknown[]) => h.createClient(...args),
}));
vi.mock('@/db/fresh-read', () => ({ freshDb: {} }));
vi.mock('@/lib/prisma', () => ({ teamMembers: {} }));
vi.mock('@/lib/guard-reconciliation/access', async () => {
  const actual = await vi.importActual<typeof import('@/lib/guard-reconciliation/access')>('@/lib/guard-reconciliation/access');
  return {
    ...actual,
    createReconciliationClient: (tenantId: string, userId: string) => {
      h.factoryCalls++;
      return actual.createReconciliationClient(tenantId, userId);
    },
  };
});
vi.mock('@/lib/user-profiles', () => ({
  loadTenantMemberProfiles: (tenantId: string, ids: string[], viewer: string) => h.profiles(tenantId, ids, viewer),
}));
vi.mock('@/lib/guard-reconciliation/decision-context', async () => {
  const actual = await vi.importActual<typeof import('@/lib/guard-reconciliation/decision-context')>(
    '@/lib/guard-reconciliation/decision-context');
  return { DECISION_ID_RE: actual.DECISION_ID_RE, loadDecisionContext: (...a: unknown[]) => h.loadDecisionContext(...a) };
});
vi.mock('@/lib/guard-reconciliation/overview', () => ({ listReconciliationOverview: (u: string) => h.overview(u) }));

const { PolicyApiError } = await import('@/services/policy/policy-api');
const { GET: overviewGET } = await import('@/app/api/guard-reconciliation/route');
const { GET: tenantGET } = await import('@/app/api/guard-reconciliation/[tenantId]/route');
const { POST: ackPOST } = await import('@/app/api/guard-reconciliation/[tenantId]/orphans/[orphanId]/ack/route');
const { GET: decisionGET } = await import('@/app/api/guard-reconciliation/[tenantId]/decisions/[decisionId]/route');

const DECISION = '8b0c6a52-5f0e-4f3f-9a64-0c9e3f2a7b11';

/** 上游列表：在内存表上按 id 降序、before 为 id < 游标、limit + next，legacy 时忽略 severity。 */
function upstreamList(q: { before?: number; severities: string[]; limit: number }) {
  h.listCalls.push({ before: q.before, severities: [...q.severities], limit: q.limit });
  const rows = h.table
    .filter((r) => q.before === undefined || r.id < q.before)
    .filter((r) => h.legacy || q.severities.length === 0 || q.severities.includes(r.severity))
    .sort((a, b) => b.id - a.id);
  const items = rows.slice(0, q.limit).map((r) => ({ executor: 'other', detectedAt: '2026-11-20T00:00:00Z', detail: {}, ...r }));
  return rows.length > q.limit ? { items, next: items[items.length - 1].id } : { items };
}

/** 依次追加 [从 id 开始, 条数, severity] 的行。 */
function seed(...segments: Array<[number, number, string]>) {
  for (const [from, n, severity] of segments) {
    for (let i = 0; i < n; i++) h.table.push({ id: from - i, severity, kind: severity === 'info' ? 'allow_unconsumed' : 'side_effect_mismatch', status: 'OPEN' });
  }
}

function asUser(id: string | null) {
  h.getSession.mockResolvedValue(id ? { user: { id } } : null);
}

function list(tenantId: string, qs = '') {
  return tenantGET(new Request(`https://x.test/api/guard-reconciliation/${tenantId}${qs}`), {
    params: Promise.resolve({ tenantId }),
  });
}

function ack(tenantId: string, orphanId: string, body: unknown = { comment: 'checked' }) {
  const req = new Request(`https://x.test/api/guard-reconciliation/${tenantId}/orphans/${orphanId}/ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return ackPOST(req, { params: Promise.resolve({ tenantId, orphanId }) });
}

function decision(tenantId: string, decisionId: string) {
  return decisionGET(new Request(`https://x.test/api/guard-reconciliation/${tenantId}/decisions/${decisionId}`), {
    params: Promise.resolve({ tenantId, decisionId }),
  });
}

const SUMMARY = { lastRun: null, open: { side_effect_mismatch: 1 }, openTotal: 1, resultGrace: 'PT15M', lookback: 'P7D' };

describe('/api/guard-reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.roles.clear();
    h.roles.set('u-viewer:team1', 'viewer');
    h.roles.set('u-member:team1', 'member');
    h.roles.set('u-admin:team1', 'admin');
    h.roles.set('u-owner:team1', 'owner');
    h.factoryCalls = 0;
    h.listCalls = [];
    h.table = [];
    h.legacy = false;
    h.summary.mockResolvedValue(SUMMARY);
    h.createClient.mockImplementation(async () => ({
      getGuardReconciliation: h.summary,
      listGuardOrphans: async (q: never) => upstreamList(q),
      ackGuardOrphan: h.ack,
      getGuardDecision: h.getDecision,
    }));
    h.profiles.mockResolvedValue(new Map());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  describe('GET [tenantId]', () => {
    it('401 without session，不建客户端', async () => {
      asUser(null);
      expect((await list('team1')).status).toBe(401);
      expect((await ack('team1', '1')).status).toBe(401);
      expect((await decision('team1', DECISION)).status).toBe(401);
      expect((await overviewGET()).status).toBe(401);
      expect(h.factoryCalls).toBe(0);
      expect(h.overview).not.toHaveBeenCalled();
    });

    it('403 for viewer and non-member, upstream not called', async () => {
      for (const [user, tenant] of [['u-viewer', 'team1'], ['u-stranger', 'team1'], ['u-member', 'u-other']]) {
        asUser(user);
        const res = await list(tenant);
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ error: 'forbidden' });
      }
      expect(h.createClient).not.toHaveBeenCalled();
      expect(h.summary).not.toHaveBeenCalled();
    });

    it('400 invalid_query for severity=high, upstream not called', async () => {
      asUser('u-member');
      for (const qs of ['?severity=high', '?status=open', '?limit=0', '?kind=bogus', '?before=x']) {
        const res = await list('team1', qs);
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'invalid_query' });
      }
      expect(h.factoryCalls).toBe(0);
      expect(h.listCalls).toHaveLength(0);
    });

    it('缺省查询：OPEN + critical,warning、50 条；返回 summary 与 canAck；个人租户签 owner', async () => {
      asUser('u1');
      seed([10, 2, 'critical']);
      const res = await list('u1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.summary).toEqual(SUMMARY);
      expect(body.canAck).toBe(true);
      expect(body.page.items.map((o: { id: number }) => o.id)).toEqual([10, 9]);
      expect(body.page).not.toHaveProperty('next');
      expect(h.listCalls).toEqual([{ before: undefined, severities: ['critical', 'warning'], limit: 50 }]);
      expect(h.createClient).toHaveBeenCalledWith('u1', 'u1', 'owner');
    });

    it('filters by severity even when upstream ignores it（旧 api，续取第 2 页，游标不漏行）', async () => {
      h.legacy = true;
      seed([1000, 2, 'critical'], [998, 48, 'info'], [950, 50, 'critical'], [900, 50, 'info']);
      asUser('u-member');

      const first = await (await list('team1', '?severity=critical&limit=50')).json();
      const ids: number[] = first.page.items.map((o: { id: number }) => o.id);
      expect(ids).toHaveLength(50);
      expect(first.page.items.every((o: { severity: string }) => o.severity === 'critical')).toBe(true);
      expect(ids.slice(0, 3)).toEqual([1000, 999, 950]);
      expect(ids.at(-1)).toBe(903);
      expect(h.listCalls.map((c) => c.before)).toEqual([undefined, 951]);
      expect(first.page.next).toBe(903);
      expect(first.canAck).toBe(false);
      expect(h.createClient).toHaveBeenCalledWith('team1', 'u-member', 'member');

      h.listCalls = [];
      const second = await (await list('team1', `?severity=critical&limit=50&before=${first.page.next}`)).json();
      expect(second.page.items.map((o: { id: number }) => o.id)).toEqual([902, 901]);
      expect(second.page).not.toHaveProperty('next');
      expect(h.listCalls.map((c) => c.before)).toEqual([903, 853]);
    });

    it('stops after 5 upstream pages（全为 info，仍返回上游游标）', async () => {
      h.legacy = true;
      seed([1000, 400, 'info']);
      asUser('u-member');
      const body = await (await list('team1', '?severity=critical')).json();
      expect(h.listCalls).toHaveLength(5);
      expect(body.page.items).toEqual([]);
      expect(body.page.next).toBe(751);
    });

    it('new api: single upstream call，next 原样', async () => {
      seed([1000, 2, 'critical'], [998, 48, 'info'], [950, 60, 'critical']);
      asUser('u-member');
      const body = await (await list('team1', '?severity=critical&limit=50')).json();
      expect(h.listCalls).toHaveLength(1);
      expect(h.listCalls[0].severities).toEqual(['critical']);
      expect(body.page.items).toHaveLength(50);
      expect(body.page.next).toBe(903);
    });

    it('severity=all 不过滤，上游不带 severity', async () => {
      seed([10, 1, 'critical'], [9, 1, 'info']);
      asUser('u-member');
      const body = await (await list('team1', '?severity=all')).json();
      expect(body.page.items.map((o: { id: number }) => o.id)).toEqual([10, 9]);
      expect(h.listCalls[0].severities).toEqual([]);
    });

    it('resolves acknowledgedBy via loadTenantMemberProfiles; profile lookup failure degrades to null', async () => {
      h.table.push({ id: 5, severity: 'critical', kind: 'side_effect_mismatch', status: 'ACKNOWLEDGED', acknowledgedBy: 'u-admin' });
      h.table.push({ id: 4, severity: 'critical', kind: 'side_effect_mismatch', status: 'ACKNOWLEDGED', acknowledgedBy: 'u-gone' });
      const ada = { name: 'Ada', email: 'ada@x.test', image: null };
      h.profiles.mockResolvedValueOnce(new Map([['u-admin', ada]]));
      asUser('u-member');

      const ok = await (await list('team1', '?status=ACKNOWLEDGED')).json();
      expect(ok.page.items.map((o: { acknowledgedByUser: unknown }) => o.acknowledgedByUser)).toEqual([ada, null]);
      expect(h.profiles).toHaveBeenCalledWith('team1', ['u-admin', 'u-gone'], 'u-member');

      h.profiles.mockRejectedValueOnce(new Error('db down'));
      const degraded = await list('team1', '?status=ACKNOWLEDGED');
      expect(degraded.status).toBe(200);
      expect((await degraded.json()).page.items.map((o: { acknowledgedByUser: unknown }) => o.acknowledgedByUser))
        .toEqual([null, null]);
    });

    it('list re-reads the role per request（member → viewer：第二次 403，不调上游）', async () => {
      asUser('u-member');
      expect((await list('team1')).status).toBe(200);
      h.roles.set('u-member:team1', 'viewer');
      expect((await list('team1')).status).toBe(403);
      expect(h.factoryCalls).toBe(2);
      expect(h.createClient).toHaveBeenCalledTimes(1);
      expect(h.listCalls).toHaveLength(1);
    });

    it('upstream 503 / timeout / 非 PolicyApiError → 502 upstream_unavailable with requestId', async () => {
      asUser('u-member');
      for (const err of [new PolicyApiError('down', 503), new PolicyApiError('Request timeout', 408, 'TIMEOUT'), new Error('boom')]) {
        h.summary.mockRejectedValueOnce(err);
        const res = await list('team1');
        expect(res.status).toBe(502);
        const body = await res.json();
        expect(body).toMatchObject({ error: 'upstream_unavailable' });
        expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
        expect(res.headers.get('x-request-id')).toBe(body.requestId);
      }
    });
  });

  describe('POST ack', () => {
    it('member cannot ack (403, upstream not called)；viewer 同样 403', async () => {
      for (const user of ['u-member', 'u-viewer', 'u-stranger']) {
        asUser(user);
        const res = await ack('team1', '7');
        expect(res.status).toBe(403);
      }
      expect(h.ack).not.toHaveBeenCalled();
    });

    it('admin ack passes trimmed comment，200 返回确认后的行；签 admin', async () => {
      const row = { id: 7, status: 'ACKNOWLEDGED', ackComment: 'checked by ops' };
      h.ack.mockResolvedValue(row);
      asUser('u-admin');
      const res = await ack('team1', '7', { comment: '  checked by ops \n' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(row);
      expect(h.ack).toHaveBeenCalledWith(7, 'checked by ops');
      expect(h.createClient).toHaveBeenCalledWith('team1', 'u-admin', 'admin');
    });

    it('owner 与个人租户本人可确认，签各自角色', async () => {
      h.ack.mockResolvedValue({ id: 1 });
      asUser('u-owner');
      expect((await ack('team1', '1')).status).toBe(200);
      asUser('u1');
      expect((await ack('u1', '1')).status).toBe(200);
      expect(h.createClient.mock.calls.map((c) => c[2])).toEqual(['owner', 'owner']);
    });

    it('blank or 1001-char comment → 400 invalid_ack, upstream not called', async () => {
      asUser('u-admin');
      for (const body of [{ comment: '' }, { comment: '   ' }, { comment: 'x'.repeat(1001) }, {}, { comment: 5 }, 'not json']) {
        const res = await ack('team1', '7', body);
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'invalid_ack' });
      }
      expect(h.ack).not.toHaveBeenCalled();
      h.ack.mockResolvedValue({ id: 7 });
      expect((await ack('team1', '7', { comment: ` ${'x'.repeat(1000)} ` })).status).toBe(200);
    });

    it('非法 orphanId → 404 orphan_not_found，不调上游', async () => {
      asUser('u-admin');
      for (const id of ['0', '-1', 'abc', '1.5', '99999999999999999999']) {
        const res = await ack('team1', id);
        expect(res.status).toBe(404);
        expect(await res.json()).toMatchObject({ error: 'orphan_not_found' });
      }
      expect(h.ack).not.toHaveBeenCalled();
    });

    it('ack re-reads the role per request（admin → member：第二次 403，不调上游）', async () => {
      h.ack.mockResolvedValue({ id: 7 });
      asUser('u-admin');
      expect((await ack('team1', '7')).status).toBe(200);
      h.roles.set('u-admin:team1', 'member');
      const res = await ack('team1', '8');
      expect(res.status).toBe(403);
      expect(h.factoryCalls).toBe(2);
      expect(h.ack).toHaveBeenCalledTimes(1);
      expect(h.createClient.mock.calls.map((c) => c[2])).toEqual(['admin', 'member']);
    });

    it('upstream 409 not_open → 409 with current status', async () => {
      h.ack.mockRejectedValue(new PolicyApiError('HTTP 409', 409, 'not_open', undefined, { error: 'not_open', status: 'RESOLVED' }));
      asUser('u-admin');
      const res = await ack('team1', '7');
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'not_open', status: 'RESOLVED' });
    });

    it('upstream 404 → 404 orphan_not_found；403 / 400 按原码透传', async () => {
      asUser('u-admin');
      h.ack.mockRejectedValueOnce(new PolicyApiError('HTTP 404', 404));
      const nf = await ack('team1', '7');
      expect(nf.status).toBe(404);
      expect(await nf.json()).toMatchObject({ error: 'orphan_not_found' });
      h.ack.mockRejectedValueOnce(new PolicyApiError('x', 400, 'invalid_ack'));
      const bad = await ack('team1', '7');
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ error: 'invalid_ack', message: expect.stringMatching(/1 to 1000/) });
    });

    it('upstream 503 / timeout → 502 upstream_unavailable with requestId', async () => {
      asUser('u-admin');
      h.ack.mockRejectedValueOnce(new PolicyApiError('down', 503));
      const res = await ack('team1', '7');
      expect(res.status).toBe(502);
      expect((await res.json()).requestId).toBeTruthy();
    });
  });

  describe('GET decisions/[decisionId]', () => {
    it('非 UUID → 400 invalid_decision_id，不建客户端', async () => {
      asUser('u-member');
      for (const id of ['abc', `${DECISION}x`, '../x']) {
        const res = await decision('team1', id);
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'invalid_decision_id' });
      }
      expect(h.factoryCalls).toBe(0);
    });

    it('viewer → 403；member → 200，以本租户与窄接口装配上下文', async () => {
      asUser('u-viewer');
      expect((await decision('team1', DECISION)).status).toBe(403);
      expect(h.loadDecisionContext).not.toHaveBeenCalled();

      h.loadDecisionContext.mockResolvedValue({ decisionId: DECISION, decision: { state: 'not_found' } });
      asUser('u-member');
      const res = await decision('team1', DECISION);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ decisionId: DECISION, decision: { state: 'not_found' } });
      const [tenantId, api, id] = h.loadDecisionContext.mock.calls[0];
      expect([tenantId, id]).toEqual(['team1', DECISION]);
      expect(Object.keys(api as object).sort()).toEqual(['ackOrphan', 'getDecision', 'listOrphans', 'summary']);
    });
  });

  describe('GET overview', () => {
    it('返回 listReconciliationOverview 的结果', async () => {
      const result = { tenants: [], unavailableTenants: ['team9'] };
      h.overview.mockResolvedValue(result);
      asUser('u1');
      const res = await overviewGET();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(result);
      expect(h.overview).toHaveBeenCalledWith('u1');
    });
  });
});
