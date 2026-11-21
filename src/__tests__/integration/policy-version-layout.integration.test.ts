// ADR 0058 §7.2、§7.5 / 计划 T4：createVersion 的 layout 三态，以及 layout 不进 envelope 与哈希链（真实 Postgres）。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts policy-version-layout.integration

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, inArray, like, sql } from 'drizzle-orm';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/cache', () => ({ invalidatePolicyCache: vi.fn(async () => undefined) }));
vi.mock('@/lib/metrics/aha-detection', () => ({ recordAhaMomentIfFirst: vi.fn(async () => false) }));

import { createDb } from '@/db';
import { policies, policyVersionLayouts, policyVersions, securityEvents, users } from '@/lib/prisma';
import { createVersion, type CreateVersionParams } from '@/services/policy/version-manager';
import { LayoutSaveError } from '@/lib/policy-layout/errors';
import { extractReservedAliasSets, getLexicon } from '@/lib/aster-lexicon';
import { LAYOUT_ERROR_CASES, LAYOUT_SOURCE, LAYOUT_VALID_CASE } from '@/__tests__/fixtures/layout-error-cases';

const PREFIX = 'it-pvlayout-cv-';
const USER = `${PREFIX}user`;
const POLICY_A = `${PREFIX}a`;
const POLICY_B = `${PREFIX}b`;
const ALL_POLICIES = [POLICY_A, POLICY_B];
const TOOLCHAIN = 'aster-cloud-it/layout';
const SCOPES = '';

const LAYOUT = LAYOUT_VALID_CASE.layout;
const SOURCE_2 = LAYOUT_SOURCE.replace('Return amount.', 'Return 0.');
const LAYOUT_2 = {
  v: 1,
  spans: [
    { text: 'Module demo.layout' },
    { canonical: '.\n\n', display: '\n' },
    { text: 'Rule decide given amount as Int, produce Int:\n  Return 0.\n' },
  ],
};
// 只在运算符别名 TIMES: ['multiplied by'] 下合法：' multiplied by ' 是结构 span；别名删除后它是标识符，被结构 span 藏住
const ALIAS_SOURCE = 'Module demo.layout.\n\nRule decide given amount as Int, produce Int:\n  Return amount multiplied by 2.\n';
const ALIAS_LAYOUT = {
  v: 1,
  spans: [
    { text: 'Module demo.layout.\n\nRule decide given amount as Int, produce Int:\n  Return amount' },
    { canonical: ' multiplied by ', display: ' × ' },
    { text: '2.\n' },
  ],
};
const RESERVED = { ...extractReservedAliasSets(getLexicon('en-US')), vocabularyTermsLower: new Set<string>() };

type Db = ReturnType<typeof createDb>;
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

function params(policyId: string, source: string, extra: Partial<CreateVersionParams> = {}): CreateVersionParams {
  return { policyId, source, createdBy: USER, locale: 'en-US', toolchainId: TOOLCHAIN, scopesJson: SCOPES, ...extra };
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('createVersion 的 layout 三态与哈希链（真实 Postgres）', () => {
  const previous = globalForDb.__asterLocalDevDb;
  const db = createDb(undefined, { max: 6 });

  /** 与 PUT 路由一致：建版本后回填 Policy.version，使下一次保存把它当作活跃版本。 */
  async function save(policyId: string, source: string, extra: Partial<CreateVersionParams> = {}) {
    const created = await createVersion(params(policyId, source, extra));
    await db.update(policies).set({ version: created.version, content: source }).where(eq(policies.id, policyId));
    return created;
  }

  async function chain(policyId: string) {
    return db
      .select({
        id: policyVersions.id,
        version: policyVersions.version,
        prevHash: policyVersions.prevHash,
        sourceHash: policyVersions.sourceHash,
        envelope: policyVersions.sourceEnvelopeSha256,
      })
      .from(policyVersions)
      .where(eq(policyVersions.policyId, policyId))
      .orderBy(asc(policyVersions.version));
  }

  async function layoutRows(policyId: string) {
    return db
      .select({ versionId: policyVersionLayouts.policyVersionId, layoutSha256: policyVersionLayouts.layoutSha256 })
      .from(policyVersionLayouts)
      .innerJoin(policyVersions, eq(policyVersions.id, policyVersionLayouts.policyVersionId))
      .where(eq(policyVersions.policyId, policyId));
  }

  async function cleanup() {
    await db.delete(securityEvents).where(inArray(securityEvents.policyId, ALL_POLICIES));
    await db.delete(policyVersions).where(inArray(policyVersions.policyId, ALL_POLICIES));
    await db.delete(policies).where(like(policies.id, `${PREFIX}%`));
    await db.delete(users).where(eq(users.id, USER));
  }

  beforeAll(() => {
    globalForDb.__asterLocalDevDb = db;
  });
  beforeEach(async () => {
    await cleanup();
    await db.insert(users).values({ id: USER, email: `${USER}@example.test`, updatedAt: new Date() });
    for (const id of ALL_POLICIES) {
      await db.insert(policies).values({ id, userId: USER, name: id, content: LAYOUT_SOURCE, version: 0, updatedAt: new Date() });
    }
  });
  afterAll(async () => {
    await cleanup();
    globalForDb.__asterLocalDevDb = previous;
    await db.$client.end();
  });

  describe('envelope 与哈希链不受 layout 影响（ADR 0058 §7.2）', () => {
    it('same inputs with and without layout produce the same sourceEnvelopeSha256 and sourceHash', async () => {
      const withLayout = await save(POLICY_A, LAYOUT_SOURCE, { layout: LAYOUT, allowLayout: true });
      const without = await save(POLICY_B, LAYOUT_SOURCE);
      expect(withLayout.layoutSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(without.layoutSha256).toBeNull();
      expect(withLayout.sourceEnvelopeSha256).toBe(without.sourceEnvelopeSha256);
      expect(withLayout.sourceHash).toBe(without.sourceHash);
    });

    it('chain is unaffected by layout', async () => {
      // A：v1 无 layout → v2 有 layout → v3 无 layout（显式 null）；B：同样输入，全无 layout
      await save(POLICY_A, LAYOUT_SOURCE);
      await save(POLICY_A, SOURCE_2, { layout: LAYOUT_2, allowLayout: true });
      await save(POLICY_A, LAYOUT_SOURCE, { layout: null });
      for (const source of [LAYOUT_SOURCE, SOURCE_2, LAYOUT_SOURCE]) await save(POLICY_B, source);

      const a = await chain(POLICY_A);
      const b = await chain(POLICY_B);
      expect(a).toHaveLength(3);
      expect((await layoutRows(POLICY_A)).map((r) => r.versionId)).toEqual([a[1].id]);
      for (const [rows, i] of [a, b].flatMap((rows) => [0, 1, 2].map((i) => [rows, i] as const))) {
        expect(rows[i].prevHash).toBe(i === 0 ? null : rows[i - 1].envelope);
      }
      for (let i = 0; i < 3; i++) {
        expect(a[i].envelope).toBe(b[i].envelope);
        expect(a[i].prevHash).toBe(b[i].prevHash);
        expect(a[i].sourceHash).toBe(b[i].sourceHash);
      }
    });
  });

  describe('提交的 layout', () => {
    it('object layout without allowLayout → 403 structured_authoring_required, no version row and no layout row written', async () => {
      const err = await createVersion(params(POLICY_A, LAYOUT_SOURCE, { layout: LAYOUT })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LayoutSaveError);
      expect(err).toMatchObject({ code: 'structured_authoring_required', status: 403 });
      expect(await chain(POLICY_A)).toHaveLength(0);
      expect(await layoutRows(POLICY_A)).toHaveLength(0);
    });

    it.each(LAYOUT_ERROR_CASES.filter((c) => c.status === 400))('$name → $code, no version row', async (c) => {
      const err = await createVersion(params(POLICY_A, c.input.source, {
        locale: c.input.locale,
        layout: c.input.layout,
        allowLayout: true,
      })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LayoutSaveError);
      expect(err).toMatchObject({ code: c.code, status: 400, detail: c.expect });
      expect(await chain(POLICY_A)).toHaveLength(0);
    });

    it('object layout with allowLayout → row inserted, layoutSha256 returned, VERSION_CREATED details carry layoutSha256 and layoutDropped:false', async () => {
      const created = await save(POLICY_A, LAYOUT_SOURCE, { layout: LAYOUT, allowLayout: true });
      expect(created.layoutDropped).toBe(false);
      expect(await layoutRows(POLICY_A)).toEqual([{ versionId: created.id, layoutSha256: created.layoutSha256 }]);
      const [event] = await db
        .select({ details: securityEvents.details })
        .from(securityEvents)
        .where(and(eq(securityEvents.policyId, POLICY_A), eq(securityEvents.eventType, 'VERSION_CREATED')));
      expect(event.details).toMatchObject({ version: created.version, layoutSha256: created.layoutSha256, layoutDropped: false });
    });

    it('object layout inside a caller transaction that rolls back leaves no layout row', async () => {
      await db.transaction(async (tx) => {
        await createVersion(params(POLICY_A, LAYOUT_SOURCE, { layout: LAYOUT, allowLayout: true, dbClient: tx }));
        tx.rollback();
      }).catch(() => undefined);
      expect(await chain(POLICY_A)).toHaveLength(0);
      expect(await layoutRows(POLICY_A)).toHaveLength(0);
    });
  });

  describe('省略 layout：沿用规则（裁决 R5、R6）', () => {
    it('omitted, previous has layout, source unchanged, allowed → carried (same layoutSha256)', async () => {
      const v1 = await save(POLICY_A, LAYOUT_SOURCE, { layout: LAYOUT, allowLayout: true });
      const v2 = await save(POLICY_A, LAYOUT_SOURCE, { allowLayout: true });
      expect(v2).toMatchObject({ layoutSha256: v1.layoutSha256, layoutDropped: false });
      expect((await layoutRows(POLICY_A)).map((r) => r.versionId).sort()).toEqual([v1.id, v2.id].sort());
    });

    it('omitted, source changed → not carried, layoutDropped:true', async () => {
      await save(POLICY_A, LAYOUT_SOURCE, { layout: LAYOUT, allowLayout: true });
      const v2 = await save(POLICY_A, SOURCE_2, { allowLayout: true });
      expect(v2).toMatchObject({ layoutSha256: null, layoutDropped: true });
      expect(await layoutRows(POLICY_A)).toHaveLength(1);
      const events = await db
        .select({ details: securityEvents.details })
        .from(securityEvents)
        .where(and(eq(securityEvents.policyId, POLICY_A), eq(securityEvents.eventType, 'VERSION_CREATED')));
      expect(events.map((e) => (e.details as { layoutDropped: boolean }).layoutDropped).sort()).toEqual([false, true]);
    });

    it('omitted, allowLayout false → not carried, layoutDropped:true', async () => {
      await save(POLICY_A, LAYOUT_SOURCE, { layout: LAYOUT, allowLayout: true });
      const v2 = await save(POLICY_A, LAYOUT_SOURCE);
      expect(v2).toMatchObject({ layoutSha256: null, layoutDropped: true });
    });

    it('omitted, aliasSet changed so a structural word is no longer a keyword → layoutDropped:true', async () => {
      const aliases = { aliasSet: { TIMES: ['multiplied by'] }, aliasReserved: RESERVED };
      const v1 = await save(POLICY_A, ALIAS_SOURCE, { ...aliases, layout: ALIAS_LAYOUT, allowLayout: true });
      expect(v1.layoutSha256).not.toBeNull();
      // 别名不变：沿用
      expect(await save(POLICY_A, ALIAS_SOURCE, { ...aliases, allowLayout: true })).toMatchObject({ layoutDropped: false });
      // 别名删除、源码不变：按新版本的别名重跑校验失败，不沿用
      const v3 = await save(POLICY_A, ALIAS_SOURCE, { aliasSet: null, allowLayout: true });
      expect(v3).toMatchObject({ layoutSha256: null, layoutDropped: true });
    });

    it('omitted, locale changed and the layout is still valid under the new lexicon → carried', async () => {
      await save(POLICY_A, LAYOUT_SOURCE, { layout: LAYOUT, allowLayout: true });
      // 换 locale 后按新 locale 的词法表重跑校验；英文规范关键词在任何 locale 下都是关键词，于是仍通过
      expect(await save(POLICY_A, LAYOUT_SOURCE, { locale: 'de-DE', allowLayout: true })).toMatchObject({ layoutDropped: false });
    });

    it('omitted, previous layout inconsistent → layoutDropped:true', async () => {
      const v1 = await save(POLICY_A, LAYOUT_SOURCE, { layout: LAYOUT, allowLayout: true });
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role = replica`);
        await tx.execute(sql`UPDATE "PolicyVersionLayout" SET "layout" = "layout" || ' ' WHERE "policyVersionId" = ${v1.id}`);
      });
      const v2 = await save(POLICY_A, LAYOUT_SOURCE, { allowLayout: true });
      expect(v2).toMatchObject({ layoutSha256: null, layoutDropped: true });
    });

    it('omitted, previous has no layout → nothing carried, not dropped', async () => {
      await save(POLICY_A, LAYOUT_SOURCE);
      expect(await save(POLICY_A, LAYOUT_SOURCE, { allowLayout: true })).toMatchObject({ layoutSha256: null, layoutDropped: false });
    });

    it('explicit null with previous layout → no layout, layoutDropped:false', async () => {
      await save(POLICY_A, LAYOUT_SOURCE, { layout: LAYOUT, allowLayout: true });
      const v2 = await save(POLICY_A, LAYOUT_SOURCE, { layout: null, allowLayout: true });
      expect(v2).toMatchObject({ layoutSha256: null, layoutDropped: false });
      expect(await layoutRows(POLICY_A)).toHaveLength(1);
    });

    it('two concurrent createVersion calls on the same policy, both carrying → each new version gets its own layout row and the chain stays linear', async () => {
      const v1 = await save(POLICY_A, LAYOUT_SOURCE, { layout: LAYOUT, allowLayout: true });
      const [x, y] = await Promise.all([
        createVersion(params(POLICY_A, LAYOUT_SOURCE, { allowLayout: true })),
        createVersion(params(POLICY_A, LAYOUT_SOURCE, { allowLayout: true })),
      ]);
      expect([x.version, y.version].sort()).toEqual([2, 3]);
      expect(x).toMatchObject({ layoutSha256: v1.layoutSha256, layoutDropped: false });
      expect(y).toMatchObject({ layoutSha256: v1.layoutSha256, layoutDropped: false });
      expect((await layoutRows(POLICY_A)).map((r) => r.versionId).sort()).toEqual([v1.id, x.id, y.id].sort());
      const rows = await chain(POLICY_A);
      expect(rows.map((r) => r.version)).toEqual([1, 2, 3]);
      for (let i = 1; i < rows.length; i++) expect(rows[i].prevHash).toBe(rows[i - 1].envelope);
    });
  });
});
