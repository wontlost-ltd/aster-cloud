// ADR 0058 §5.1、§7.5 / 计划 T5：三条保存路由的 layout 门禁、layoutChanged 判定（裁决 R4）与 layout 错误响应。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const returning = vi.fn();
  const tx = {
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning })) })) })),
  };
  return {
    returning,
    tx,
    createVersion: vi.fn(),
    resolveEntitlement: vi.fn(),
    activeLayoutSha256: vi.fn(),
    activeLayoutSha256ForPolicy: vi.fn(),
    activeVersionFindFirst: vi.fn(),
  };
});

vi.mock('@/lib/auth', () => ({ getSession: vi.fn(async () => ({ user: { id: 'user-1' } })) }));
vi.mock('@/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'user-1' } })) }));
vi.mock('@/services/policy/version-manager', () => ({
  createVersion: h.createVersion,
  assertCompilable: vi.fn(async () => null),
  listVersions: vi.fn(),
  listExecutableVersions: vi.fn(),
  PolicyCompileError: class PolicyCompileError extends Error {},
}));
vi.mock('@/lib/policy-compile-validator', () => ({
  loadSaveVocabulary: vi.fn(async () => ({ vocabulary: { id: 'v' }, scopesJson: '' })),
  makeCompileValidator: vi.fn(() => vi.fn()),
}));
vi.mock('@/lib/structural-alias-grants', () => ({
  getStructuralAliasGrant: vi.fn(async () => false),
  buildAliasReservedForUser: vi.fn(),
}));
vi.mock('@/lib/capabilities/resolve', () => ({ resolveEntitlement: h.resolveEntitlement }));
vi.mock('@/lib/policy-layout/store', () => ({
  activeLayoutSha256: h.activeLayoutSha256,
  activeLayoutSha256ForPolicy: h.activeLayoutSha256ForPolicy,
  loadVersionLayout: vi.fn(),
}));
vi.mock('@/lib/policy-freeze', () => ({
  isPolicyFrozen: vi.fn(async () => ({ isFrozen: false })),
  getPolicyFreezeStatus: vi.fn(),
}));
vi.mock('@/lib/cache', () => ({ invalidatePolicyCache: vi.fn(async () => undefined) }));
vi.mock('@/lib/product-events/server', () => ({ recordProductEventAfterResponse: vi.fn() }));
vi.mock('@/services/pii/detector', () => ({ detectPII: vi.fn(() => ({ detectedTypes: [] })) }));
vi.mock('@/lib/policy-access', async () =>
  (await import('@/__tests__/helpers/policy-access-mock')).policyAccessModule());
vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      users: { findFirst: vi.fn(async () => undefined) },
      policyVersions: { findFirst: h.activeVersionFindFirst },
      policies: { findFirst: vi.fn() },
    },
    execute: vi.fn(async () => [{ test: 1 }]),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(h.tx)),
  },
  policies: { id: {}, userId: {}, deletedAt: {}, isPublic: {}, version: {} },
  policyVersions: { policyId: {}, version: {} },
  policyGroups: { id: {}, userId: {} },
  executions: { policyId: {} },
  users: { id: {} },
}));

import { POST as POST_POLICY } from '@/app/api/policies/route';
import { PUT } from '@/app/api/policies/[id]/route';
import { POST as POST_VERSION } from '@/app/api/v1/policies/[id]/versions/route';
import { policyAccessState } from '@/__tests__/helpers/policy-access-mock';
import { LAYOUT_ERROR_CASES, LAYOUT_SOURCE, LAYOUT_VALID_CASE } from '@/__tests__/fixtures/layout-error-cases';
import { LayoutSaveError } from '@/lib/policy-layout/errors';
import { sha256Utf8Hex } from '@/lib/policy-layout/hash';
import { serializeLayout, type PolicyLayout } from '@aster-cloud/aster-lang-ts/layout';

const LAYOUT = LAYOUT_VALID_CASE.layout as PolicyLayout;
const LAYOUT_SHA = sha256Utf8Hex(serializeLayout(LAYOUT));
const OTHER_SHA = 'f'.repeat(64);
const ALLOWED = { allowed: true, sources: [{ kind: 'direct', grantId: 'g' }] };
const POLICY_ROW = { id: 'p1', userId: 'user-1', teamId: 'team-1', name: 'p', content: LAYOUT_SOURCE, version: 3, isPublic: false };

function json(url: string, method: string, body: Record<string, unknown>) {
  return new Request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
const params = { params: Promise.resolve({ id: 'p1' }) };

const ROUTES = {
  'POST /api/policies': (body: Record<string, unknown>) =>
    POST_POLICY(json('http://localhost/api/policies', 'POST', { name: 'n', content: LAYOUT_SOURCE, ...body })),
  'PUT /api/policies/[id]': (body: Record<string, unknown>) =>
    PUT(json('http://localhost/api/policies/p1', 'PUT', { content: LAYOUT_SOURCE, ...body }), params),
  'POST /api/v1/policies/[id]/versions': (body: Record<string, unknown>) =>
    POST_VERSION(json('http://localhost/api/v1/policies/p1/versions', 'POST', { source: LAYOUT_SOURCE, ...body }) as never, params),
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  policyAccessState.policy = { ...POLICY_ROW };
  policyAccessState.teamRole = 'member';
  policyAccessState.loader = null;
  h.returning.mockResolvedValue([{ ...POLICY_ROW }]);
  h.activeVersionFindFirst.mockResolvedValue({ id: 'ver-3', aliasSet: null, sourceScopesJson: null });
  h.activeLayoutSha256.mockResolvedValue(null);
  h.activeLayoutSha256ForPolicy.mockResolvedValue(null);
  h.resolveEntitlement.mockResolvedValue(ALLOWED);
  h.createVersion.mockResolvedValue({
    id: 'ver-4', version: 4, sourceHash: 'h', sourceEnvelopeSha256: 'e', layoutSha256: LAYOUT_SHA, layoutDropped: false,
  });
});

describe.each(Object.keys(ROUTES) as (keyof typeof ROUTES)[])('%s：layout 错误响应', (route) => {
  it.each(LAYOUT_ERROR_CASES)('createVersion throws $code → $status with code and detail', async (c) => {
    h.createVersion.mockRejectedValueOnce(new LayoutSaveError(c.code, c.status, 'rejected', c.expect));
    // PUT 只在有变更时建版本：提交与活跃版本不同的 layout
    const res = await ROUTES[route]({ layout: c.input.layout });
    expect(res.status).toBe(c.status);
    expect(await res.json()).toEqual({ error: 'rejected', code: c.code, ...c.expect });
  });
});

describe('PUT /api/policies/[id]：只改 layout（裁决 R4）', () => {
  it('content and aliasSet unchanged, layout differs from the active version → new version with that layout', async () => {
    h.activeLayoutSha256.mockResolvedValue(OTHER_SHA);
    const res = await ROUTES['PUT /api/policies/[id]']({ layout: LAYOUT });
    expect(res.status).toBe(200);
    expect(h.activeLayoutSha256).toHaveBeenCalledWith('ver-3');
    expect(h.createVersion).toHaveBeenCalledWith(expect.objectContaining({ layout: LAYOUT, allowLayout: true }));
  });

  it('layout identical to the active version (same layoutSha256) → no new version', async () => {
    h.activeLayoutSha256.mockResolvedValue(LAYOUT_SHA);
    // 键序不同、相邻内容 span 未合并的同一 layout 序列化后相同
    const res = await ROUTES['PUT /api/policies/[id]']({ layout: { spans: LAYOUT.spans, v: 1 } });
    expect(res.status).toBe(200);
    expect(h.createVersion).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ layoutDropped: false });
  });

  it('null while the active version has no layout → no new version', async () => {
    await ROUTES['PUT /api/policies/[id]']({ layout: null });
    expect(h.createVersion).not.toHaveBeenCalled();
  });

  it('null while the active version has a layout → new version with layout null', async () => {
    h.activeLayoutSha256.mockResolvedValue(LAYOUT_SHA);
    await ROUTES['PUT /api/policies/[id]']({ layout: null });
    expect(h.createVersion).toHaveBeenCalledWith(expect.objectContaining({ layout: null }));
    expect(h.resolveEntitlement).not.toHaveBeenCalled();
  });

  it('malformed layout counts as changed and reaches createVersion (which reports 400)', async () => {
    h.activeLayoutSha256.mockResolvedValue(LAYOUT_SHA);
    await ROUTES['PUT /api/policies/[id]']({ layout: { v: 2 } });
    expect(h.createVersion).toHaveBeenCalledWith(expect.objectContaining({ layout: { v: 2 } }));
  });
});

describe('PUT /api/policies/[id]：能力解析', () => {
  it('layout omitted, content changed, active version has no layout → resolveEntitlement not called', async () => {
    await ROUTES['PUT /api/policies/[id]']({ content: `${LAYOUT_SOURCE}\n` });
    expect(h.createVersion).toHaveBeenCalledWith(expect.objectContaining({ layout: undefined, allowLayout: false }));
    expect(h.resolveEntitlement).not.toHaveBeenCalled();
  });

  it('layout omitted, content changed, active version has a layout → resolved once with the policy teamId', async () => {
    h.activeLayoutSha256.mockResolvedValue(LAYOUT_SHA);
    await ROUTES['PUT /api/policies/[id]']({ content: `${LAYOUT_SOURCE}\n` });
    expect(h.resolveEntitlement).toHaveBeenCalledTimes(1);
    expect(h.resolveEntitlement).toHaveBeenCalledWith('user-1', 'structured_authoring', { teamId: 'team-1' });
    expect(h.createVersion).toHaveBeenCalledWith(expect.objectContaining({ layout: undefined, allowLayout: true }));
  });

  it('teammate without the capability: allowLayout false is passed and the save succeeds with layoutDropped', async () => {
    h.activeLayoutSha256.mockResolvedValue(LAYOUT_SHA);
    h.resolveEntitlement.mockResolvedValue({ allowed: false, denial: 'not_granted', sources: [] });
    h.createVersion.mockResolvedValue({
      id: 'ver-4', version: 4, sourceHash: 'h', sourceEnvelopeSha256: 'e', layoutSha256: null, layoutDropped: true,
    });
    const res = await ROUTES['PUT /api/policies/[id]']({ content: `${LAYOUT_SOURCE}\n` });
    expect(res.status).toBe(200);
    expect(h.createVersion).toHaveBeenCalledWith(expect.objectContaining({ allowLayout: false }));
    expect(await res.json()).toMatchObject({ id: 'p1', layoutDropped: true });
  });

  it('no version change (name only) → neither createVersion nor resolveEntitlement, layoutDropped false', async () => {
    h.activeLayoutSha256.mockResolvedValue(LAYOUT_SHA);
    const res = await PUT(json('http://localhost/api/policies/p1', 'PUT', { name: 'renamed' }), params);
    expect(res.status).toBe(200);
    expect(h.createVersion).not.toHaveBeenCalled();
    expect(h.resolveEntitlement).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ layoutDropped: false });
  });
});

describe('POST /api/policies', () => {
  it('layout object with entitlement denied (plan_required) → allowLayout:false passed to createVersion', async () => {
    h.resolveEntitlement.mockResolvedValue({ allowed: false, denial: 'plan_required', sources: [] });
    await ROUTES['POST /api/policies']({ layout: LAYOUT, teamId: undefined });
    expect(h.resolveEntitlement).toHaveBeenCalledWith('user-1', 'structured_authoring', { teamId: null });
    expect(h.createVersion).toHaveBeenCalledWith(expect.objectContaining({ layout: LAYOUT, allowLayout: false }));
  });

  it('layout object with entitlement → allowLayout:true', async () => {
    const res = await ROUTES['POST /api/policies']({ layout: LAYOUT });
    expect(res.status).toBe(201);
    expect(h.createVersion).toHaveBeenCalledWith(expect.objectContaining({ layout: LAYOUT, allowLayout: true }));
  });

  it('no layout → entitlement not resolved, layout omitted', async () => {
    await ROUTES['POST /api/policies']({});
    expect(h.resolveEntitlement).not.toHaveBeenCalled();
    expect(h.createVersion).toHaveBeenCalledWith(expect.objectContaining({ layout: undefined, allowLayout: false }));
  });
});

describe('POST /api/v1/policies/[id]/versions', () => {
  it('response carries layoutSha256 and layoutDropped', async () => {
    const res = await ROUTES['POST /api/v1/policies/[id]/versions']({ layout: LAYOUT });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ layoutSha256: LAYOUT_SHA, layoutDropped: false });
    expect(h.createVersion).toHaveBeenCalledWith(expect.objectContaining({ layout: LAYOUT, allowLayout: true }));
    expect(h.resolveEntitlement).toHaveBeenCalledWith('user-1', 'structured_authoring', { teamId: 'team-1' });
  });

  it('layout omitted and the active version has none → entitlement not resolved', async () => {
    await ROUTES['POST /api/v1/policies/[id]/versions']({});
    expect(h.activeLayoutSha256ForPolicy).toHaveBeenCalledWith('p1');
    expect(h.resolveEntitlement).not.toHaveBeenCalled();
    expect(h.createVersion).toHaveBeenCalledWith(expect.objectContaining({ layout: undefined, allowLayout: false }));
  });

  it('layout omitted and the active version has one → resolved so it can be carried', async () => {
    h.activeLayoutSha256ForPolicy.mockResolvedValue(LAYOUT_SHA);
    await ROUTES['POST /api/v1/policies/[id]/versions']({});
    expect(h.resolveEntitlement).toHaveBeenCalledTimes(1);
    expect(h.createVersion).toHaveBeenCalledWith(expect.objectContaining({ allowLayout: true }));
  });

  it('explicit null → entitlement not resolved', async () => {
    h.activeLayoutSha256ForPolicy.mockResolvedValue(LAYOUT_SHA);
    await ROUTES['POST /api/v1/policies/[id]/versions']({ layout: null });
    expect(h.resolveEntitlement).not.toHaveBeenCalled();
    expect(h.createVersion).toHaveBeenCalledWith(expect.objectContaining({ layout: null, allowLayout: false }));
  });
});
