// ADR 0060 §6.2 / 计划 T1：PolicyVersion.embeddedVocabulary 列与大小 CHECK，真实 Postgres。
// 验证：列形态（text、可空、无默认值）、NULL 与 8192 字节通过、8193 字节被约束
// PolicyVersion_embeddedVocabulary_size_check 拒绝（按 UTF-8 字节而非字符计）、UPDATE 同样受约束、
// 值逐字节往返（text 不重排键）。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts policy-version-embedded-vocabulary

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';

import { createDb } from '@/db';
import { policyVersions } from '@/lib/prisma';

const PREFIX = 'it-pvembvocab-';
const POLICY = `${PREFIX}policy`;
const CONSTRAINT = 'PolicyVersion_embeddedVocabulary_size_check';
// 三字节 UTF-8 汉字：2730 个 = 8190 字节
const HAN = '静';

type Db = ReturnType<typeof createDb>;

let seq = 0;

function insertVersion(db: Db, embeddedVocabulary?: string | null) {
  const id = `${PREFIX}v-${++seq}`;
  const values: typeof policyVersions.$inferInsert = {
    id,
    policyId: POLICY,
    version: seq,
    content: 'Module it.embedded.',
  };
  if (embeddedVocabulary !== undefined) values.embeddedVocabulary = embeddedVocabulary;
  return { id, done: db.insert(policyVersions).values(values) };
}

async function storedValue(db: Db, id: string): Promise<string | null> {
  const rows = await db
    .select({ v: policyVersions.embeddedVocabulary })
    .from(policyVersions)
    .where(eq(policyVersions.id, id));
  expect(rows).toHaveLength(1);
  return rows[0].v;
}

/** 取出 drizzle 包装错误里 Postgres 的约束名与 SQLSTATE。 */
async function rejection(p: Promise<unknown>): Promise<{ constraint?: string; code?: string; text: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string; constraint_name?: string; code?: string } };
    return {
      constraint: err.cause?.constraint_name,
      code: err.cause?.code,
      text: `${err.message ?? ''} ${err.cause?.message ?? ''}`,
    };
  }
  throw new Error('期望写入被拒绝，但成功了');
}

function expectSizeCheckViolation(r: { constraint?: string; code?: string; text: string }) {
  // 23514 = check_violation
  expect(r.code).toBe('23514');
  expect(r.constraint).toBe(CONSTRAINT);
  expect(r.text).toContain(CONSTRAINT);
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('PolicyVersion.embeddedVocabulary 列与大小 CHECK（真实 Postgres）', () => {
  const db: Db = createDb(undefined, { max: 2 });

  async function cleanup() {
    await db.delete(policyVersions).where(like(policyVersions.id, `${PREFIX}%`));
  }

  beforeAll(cleanup);
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await db.$client.end({ timeout: 1 });
  });

  it('column is nullable text with no default', async () => {
    const rows = await db.execute<{ data_type: string; is_nullable: string; column_default: string | null }>(sql`
      SELECT data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'PolicyVersion' AND column_name = 'embeddedVocabulary'
    `);
    expect([...rows]).toEqual([{ data_type: 'text', is_nullable: 'YES', column_default: null }]);
  });

  it('constraint definition is exactly the size bound', async () => {
    const rows = await db.execute<{ def: string }>(sql`
      SELECT pg_get_constraintdef(co.oid) AS def
      FROM pg_constraint co JOIN pg_class c ON c.oid = co.conrelid
      WHERE c.relname = 'PolicyVersion' AND co.conname = ${CONSTRAINT} AND co.contype = 'c'
    `);
    expect([...rows].map((r) => r.def)).toEqual([
      'CHECK ((("embeddedVocabulary" IS NULL) OR (octet_length("embeddedVocabulary") <= 8192)))',
    ]);
  });

  it('accepts NULL and an 8192-byte value, rejects 8193 bytes', async () => {
    const omitted = insertVersion(db);
    await omitted.done;
    expect(await storedValue(db, omitted.id)).toBeNull();

    const explicitNull = insertVersion(db, null);
    await explicitNull.done;
    expect(await storedValue(db, explicitNull.id)).toBeNull();

    const atLimit = insertVersion(db, 'x'.repeat(8192));
    await atLimit.done;
    expect(await storedValue(db, atLimit.id)).toHaveLength(8192);

    const over = insertVersion(db, 'x'.repeat(8193));
    expectSizeCheckViolation(await rejection(over.done));
    expect(await db.select().from(policyVersions).where(eq(policyVersions.id, over.id))).toHaveLength(0);
  });

  it('counts UTF-8 bytes, not characters', async () => {
    // 2730 个汉字 + 2 个 ASCII = 8192 字节（2732 个字符）
    const atLimit = insertVersion(db, HAN.repeat(2730) + 'xx');
    await atLimit.done;
    expect(await storedValue(db, atLimit.id)).toBe(HAN.repeat(2730) + 'xx');

    // 2731 个汉字 = 8193 字节，但只有 2731 个字符，仍被拒
    const over = insertVersion(db, HAN.repeat(2731));
    expectSizeCheckViolation(await rejection(over.done));
  });

  it('UPDATE beyond the bound is rejected and the row is unchanged', async () => {
    const v = insertVersion(db, '{"v":1,"terms":[]}');
    await v.done;
    expectSizeCheckViolation(
      await rejection(
        db.update(policyVersions).set({ embeddedVocabulary: 'y'.repeat(8193) }).where(eq(policyVersions.id, v.id))
      )
    );
    expect(await storedValue(db, v.id)).toBe('{"v":1,"terms":[]}');
  });

  it('round-trips the serialized bytes verbatim (text, not jsonb)', async () => {
    // jsonb 会按键长重排键序、丢弃原样字节；text 必须逐字节保留确定性序列化的结果
    const serialized =
      '{"v":1,"terms":[{"kind":"literal","localized":"思故乡","canonical":"静夜思"},' +
      '{"kind":"struct","localized":"望明月","canonical":"Text"}]}';
    const v = insertVersion(db, serialized);
    await v.done;
    expect(await storedValue(db, v.id)).toBe(serialized);
  });
});
