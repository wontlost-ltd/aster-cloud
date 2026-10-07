import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * audit #168: every /api/internal/** handler must fail CLOSED — when
 * ASTER_PLAN_GATE_HMAC_KEY is unset it returns 503 and never touches the DB /
 * business logic. One parametric guard across all 8 routes catches a per-file
 * regression in the fail-closed block.
 */

// DB + business deps are mocked to throw if reached — a 503 must short-circuit
// before any of them run.
const boom = () => { throw new Error('handler reached business logic while HMAC key unset'); };

vi.mock('drizzle-orm', () => new Proxy({}, { get: () => () => ({}) }));
vi.mock('@/lib/prisma', () => ({
  db: {
    query: new Proxy({}, { get: () => ({ findFirst: boom, findMany: boom }) }),
    insert: boom, select: boom, update: boom, delete: boom,
  },
  users: {}, apiKeys: {}, teams: {}, teamMembers: {}, apiCallRecords: {},
}));
vi.mock('@/lib/plans', () => ({ getEffectiveLimits: boom }));
vi.mock('@/lib/ai-quota', () => ({ checkAiQuota: boom, recordAiUsage: boom }));
vi.mock('@/lib/api-rate-limiter', () => ({ checkRate: boom }));
vi.mock('@/lib/team-permissions', () => ({ SOLO_TENANT_ROLE: 'owner' }));
vi.mock('@/lib/api-key-identity', () => ({
  resolveApiKeyIdentity: boom,
  resolveApiKeyIdentities: boom,
  API_KEY_IDENTITY_COLUMNS: {},
}));

const originalKey = process.env.ASTER_PLAN_GATE_HMAC_KEY;

type Case = {
  name: string;
  path: string;
  method: 'GET' | 'POST';
  mod: string;
  params?: Record<string, string>;
};

const CASES: Case[] = [
  { name: 'apikey/verify POST', path: '/api/internal/apikey/verify', method: 'POST', mod: '@/app/api/internal/apikey/verify/route' },
  { name: 'tenant/[id]/plan GET', path: '/api/internal/tenant/t1/plan', method: 'GET', mod: '@/app/api/internal/tenant/[id]/plan/route', params: { id: 't1' } },
  { name: 'snapshot/full GET', path: '/api/internal/snapshot/full', method: 'GET', mod: '@/app/api/internal/snapshot/full/route' },
  { name: 'ai/quota GET', path: '/api/internal/ai/quota', method: 'GET', mod: '@/app/api/internal/ai/quota/route' },
  { name: 'ai/usage POST', path: '/api/internal/ai/usage', method: 'POST', mod: '@/app/api/internal/ai/usage/route' },
  { name: 'api/precheck GET', path: '/api/internal/api/precheck', method: 'GET', mod: '@/app/api/internal/api/precheck/route' },
  { name: 'api/rate-check POST', path: '/api/internal/api/rate-check', method: 'POST', mod: '@/app/api/internal/api/rate-check/route' },
  { name: 'api/usage GET', path: '/api/internal/api/usage', method: 'GET', mod: '@/app/api/internal/api/usage/route' },
  { name: 'api/usage POST', path: '/api/internal/api/usage', method: 'POST', mod: '@/app/api/internal/api/usage/route' },
];

describe('internal routes fail-closed when HMAC key unset (audit #168)', () => {
  beforeEach(() => { vi.resetModules(); delete process.env.ASTER_PLAN_GATE_HMAC_KEY; });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.ASTER_PLAN_GATE_HMAC_KEY;
    else process.env.ASTER_PLAN_GATE_HMAC_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it.each(CASES)('$name → 503, no DB/logic reached', async (c) => {
    const mod = await import(c.mod);
    const handler = mod[c.method];
    const req = new Request(`http://cloud.test${c.path}`, {
      method: c.method,
      ...(c.method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
    });
    const ctx = c.params ? { params: Promise.resolve(c.params) } : undefined;
    const res = await (ctx ? handler(req, ctx) : handler(req));
    expect(res.status).toBe(503);
  });
});
