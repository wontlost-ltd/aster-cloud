// ADR 0058 §7.2 / 计划 T2：PolicyVersionLayout 表约束与只插入 trigger，真实 Postgres。
// 验证主键（每版本至多一行）、四条 CHECK、外键，以及裁决 R8：UPDATE 一律拒绝、直接 DELETE 拒绝、
// 只随父 PolicyVersion 级联删除（单行与多行、事务内）。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts policy-version-layout-schema

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';

import { createDb } from '@/db';
import { policyVersionLayouts, policyVersions } from '@/lib/prisma';

const PREFIX = 'it-pvlayout-';
const POLICY = `${PREFIX}policy`;
const HEX_A = 'a'.repeat(64);
const HEX_B = '0123456789abcdef'.repeat(4);

type Db = ReturnType<typeof createDb>;
type LayoutInsert = typeof policyVersionLayouts.$inferInsert;

let seq = 0;

async function seedVersion(db: Db): Promise<string> {
  const id = `${PREFIX}v-${++seq}`;
  await db.insert(policyVersions).values({ id, policyId: POLICY, version: seq, content: 'Module it.layout.' });
  return id;
}

function layoutRow(policyVersionId: string, overrides: Partial<LayoutInsert> = {}): LayoutInsert {
  return {
    policyVersionId,
    formatVersion: 1,
    layout: '{"v":1,"spans":[]}',
    layoutSha256: HEX_A,
    sourceSha256: HEX_B,
    createdBy: 'it-pvlayout-user-without-fk',
    ...overrides,
  };
}

/** 取出 drizzle 包装错误里 Postgres 的原始报错文本，便于断言约束名与 trigger 消息。 */
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string; constraint_name?: string; code?: string } };
    return `${err.message ?? ''} ${err.cause?.message ?? ''} ${err.cause?.constraint_name ?? ''} ${err.cause?.code ?? ''}`;
  }
  throw new Error('期望写入被拒绝，但成功了');
}

async function layoutsFor(db: Db, policyVersionId: string) {
  return db.select().from(policyVersionLayouts).where(eq(policyVersionLayouts.policyVersionId, policyVersionId));
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('PolicyVersionLayout 表约束与只插入 trigger（真实 Postgres）', () => {
  const db: Db = createDb(undefined, { max: 2 });

  // 只能经由删父版本清理 layout 行（直接 DELETE 会被 trigger 拒绝）
  async function cleanup() {
    await db.delete(policyVersions).where(like(policyVersions.id, `${PREFIX}%`));
  }

  beforeAll(cleanup);
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await db.$client.end({ timeout: 1 });
  });

  it('accepts a valid row; createdBy has no foreign key and createdAt defaults', async () => {
    const v = await seedVersion(db);
    await db.insert(policyVersionLayouts).values(layoutRow(v));
    const rows = await layoutsFor(db, v);
    expect(rows).toHaveLength(1);
    expect(rows[0].createdBy).toBe('it-pvlayout-user-without-fk');
    expect(rows[0].createdAt).toBeInstanceOf(Date);
  });

  it('second row for the same version violates the primary key', async () => {
    const v = await seedVersion(db);
    await db.insert(policyVersionLayouts).values(layoutRow(v));
    const msg = await rejection(db.insert(policyVersionLayouts).values(layoutRow(v, { layoutSha256: HEX_B })));
    expect(msg).toContain('PolicyVersionLayout_pkey');
  });

  it('row for a non-existent PolicyVersion violates the foreign key', async () => {
    const msg = await rejection(db.insert(policyVersionLayouts).values(layoutRow(`${PREFIX}missing`)));
    expect(msg).toContain('23503');
  });

  it.each([0, 2])('formatVersion %i rejected', async (formatVersion) => {
    const v = await seedVersion(db);
    const msg = await rejection(db.insert(policyVersionLayouts).values(layoutRow(v, { formatVersion })));
    expect(msg).toContain('PolicyVersionLayout_format_ck');
  });

  it.each([
    ['uppercase', 'A'.repeat(64)],
    ['sha256:-prefixed', `sha256:${HEX_A}`],
    ['63 chars', 'a'.repeat(63)],
    ['65 chars', 'a'.repeat(65)],
    ['non-hex', 'g'.repeat(64)],
  ])('%s layoutSha256 rejected', async (_label, layoutSha256) => {
    const v = await seedVersion(db);
    const msg = await rejection(db.insert(policyVersionLayouts).values(layoutRow(v, { layoutSha256 })));
    expect(msg).toContain('PolicyVersionLayout_layout_sha_ck');
  });

  it.each([
    ['uppercase', 'F'.repeat(64)],
    ['sha256:-prefixed', `sha256:${HEX_B}`],
  ])('%s sourceSha256 rejected', async (_label, sourceSha256) => {
    const v = await seedVersion(db);
    const msg = await rejection(db.insert(policyVersionLayouts).values(layoutRow(v, { sourceSha256 })));
    expect(msg).toContain('PolicyVersionLayout_source_sha_ck');
  });

  it('layout of 49152 bytes accepted, 49153 bytes rejected (counted in UTF-8 bytes, not characters)', async () => {
    const ok = await seedVersion(db);
    await db.insert(policyVersionLayouts).values(layoutRow(ok, { layout: 'x'.repeat(49152) }));
    expect(await layoutsFor(db, ok)).toHaveLength(1);

    const tooBig = await seedVersion(db);
    const msg = await rejection(
      db.insert(policyVersionLayouts).values(layoutRow(tooBig, { layout: 'x'.repeat(49153) })),
    );
    expect(msg).toContain('PolicyVersionLayout_size_ck');

    // 16385 个三字节汉字 = 49155 字节，但只有 16385 个字符
    const cjk = await seedVersion(db);
    const cjkMsg = await rejection(
      db.insert(policyVersionLayouts).values(layoutRow(cjk, { layout: '静'.repeat(16385) })),
    );
    expect(cjkMsg).toContain('PolicyVersionLayout_size_ck');
  });

  it.each([
    ['layout', sql`"layout" = '{"v":1,"spans":[{"c":"x"}]}'`],
    ['layoutSha256', sql`"layoutSha256" = ${HEX_B}`],
    ['sourceSha256', sql`"sourceSha256" = ${HEX_A}`],
    ['createdBy', sql`"createdBy" = NULL`],
    ['createdAt', sql`"createdAt" = now()`],
    ['no-op (same value)', sql`"formatVersion" = 1`],
  ])('UPDATE of %s raises append-only and leaves the row unchanged', async (_col, set) => {
    const v = await seedVersion(db);
    await db.insert(policyVersionLayouts).values(layoutRow(v));
    const before = await layoutsFor(db, v);
    const msg = await rejection(
      db.execute(sql`UPDATE "PolicyVersionLayout" SET ${set} WHERE "policyVersionId" = ${v}`),
    );
    expect(msg).toContain('append-only: UPDATE on PolicyVersionLayout is forbidden');
    expect(await layoutsFor(db, v)).toEqual(before);
  });

  it('UPDATE through the ORM raises append-only too', async () => {
    const v = await seedVersion(db);
    await db.insert(policyVersionLayouts).values(layoutRow(v));
    const msg = await rejection(
      db.update(policyVersionLayouts).set({ layoutSha256: HEX_B }).where(eq(policyVersionLayouts.policyVersionId, v)),
    );
    expect(msg).toContain('append-only: UPDATE on PolicyVersionLayout is forbidden');
  });

  it('direct DELETE of a layout row raises append-only and the row stays', async () => {
    const v = await seedVersion(db);
    await db.insert(policyVersionLayouts).values(layoutRow(v));
    const msg = await rejection(
      db.delete(policyVersionLayouts).where(eq(policyVersionLayouts.policyVersionId, v)),
    );
    expect(msg).toContain('append-only: direct DELETE on PolicyVersionLayout is forbidden');
    expect(await layoutsFor(db, v)).toHaveLength(1);
  });

  it('unfiltered DELETE on the table is rejected as a whole (no partial deletion)', async () => {
    const v1 = await seedVersion(db);
    const v2 = await seedVersion(db);
    await db.insert(policyVersionLayouts).values([layoutRow(v1), layoutRow(v2)]);
    const msg = await rejection(db.execute(sql`DELETE FROM "PolicyVersionLayout" WHERE "policyVersionId" LIKE ${PREFIX + '%'}`));
    expect(msg).toContain('append-only: direct DELETE on PolicyVersionLayout is forbidden');
    expect(await layoutsFor(db, v1)).toHaveLength(1);
    expect(await layoutsFor(db, v2)).toHaveLength(1);
  });

  it('deleting the PolicyVersion cascades to the layout row (same transaction, no error)', async () => {
    const v = await seedVersion(db);
    const other = await seedVersion(db);
    await db.insert(policyVersionLayouts).values([layoutRow(v), layoutRow(other)]);

    await db.transaction(async (tx) => {
      await tx.delete(policyVersions).where(eq(policyVersions.id, v));
      // 同一事务内父行删除后子行已不可见
      expect(await tx.select().from(policyVersionLayouts).where(eq(policyVersionLayouts.policyVersionId, v))).toHaveLength(0);
    });

    expect(await layoutsFor(db, v)).toHaveLength(0);
    // 别的版本的 layout 不受影响
    expect(await layoutsFor(db, other)).toHaveLength(1);
  });

  it('multi-row parent delete cascades every layout row', async () => {
    const ids = [await seedVersion(db), await seedVersion(db), await seedVersion(db)];
    await db.insert(policyVersionLayouts).values(ids.map((id) => layoutRow(id)));
    await db.delete(policyVersions).where(eq(policyVersions.policyId, POLICY));
    const left = await db.select().from(policyVersionLayouts).where(like(policyVersionLayouts.policyVersionId, `${PREFIX}%`));
    expect(left).toHaveLength(0);
  });

  it('a rolled-back parent delete leaves both rows in place', async () => {
    const v = await seedVersion(db);
    await db.insert(policyVersionLayouts).values(layoutRow(v));
    await expect(
      db.transaction(async (tx) => {
        await tx.delete(policyVersions).where(eq(policyVersions.id, v));
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await layoutsFor(db, v)).toHaveLength(1);
  });

  it('the guard trigger is installed as BEFORE UPDATE OR DELETE FOR EACH ROW', async () => {
    const rows = await db.execute<{ def: string }>(sql`
      SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t
      WHERE t.tgrelid = '"PolicyVersionLayout"'::regclass AND NOT t.tgisinternal`);
    expect(rows.map((r) => r.def)).toEqual([
      'CREATE TRIGGER "PolicyVersionLayout_guard" BEFORE DELETE OR UPDATE ON public."PolicyVersionLayout" FOR EACH ROW EXECUTE FUNCTION policy_version_layout_guard()',
    ]);
  });
});
