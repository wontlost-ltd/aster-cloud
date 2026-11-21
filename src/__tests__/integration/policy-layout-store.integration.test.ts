// ADR 0058 §7.2 / 计划 T3：layout 存储的插入与读取复验（真实 Postgres）。
// 复验四项：layout 哈希、源码哈希、可解析、往返相等；任何一项不过即 inconsistent（读接口仍 200）。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts policy-layout-store

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';

vi.mock('server-only', () => ({}));

import { createDb } from '@/db';
import { policies, policyVersions, users } from '@/lib/prisma';
import { LAYOUT_SOURCE, LAYOUT_VALID_CASE } from '@/__tests__/fixtures/layout-error-cases';
import { sha256Utf8Hex } from '@/lib/policy-layout/hash';
import {
  activeLayoutSha256,
  activeLayoutSha256ForPolicy,
  insertVersionLayout,
  loadCarryCandidate,
  loadVersionLayout,
  prepareLayout,
} from '@/lib/policy-layout/store';

const PREFIX = 'it-pvlstore-';
const USER = `${PREFIX}user`;
const POLICY = `${PREFIX}policy`;

type Db = ReturnType<typeof createDb>;
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

let seq = 0;

async function seedVersion(db: Db, source = LAYOUT_SOURCE): Promise<string> {
  const id = `${PREFIX}v-${++seq}`;
  await db.insert(policyVersions).values({ id, policyId: POLICY, version: seq, source, content: source });
  return id;
}

const prepared = () => prepareLayout(LAYOUT_VALID_CASE.layout, { source: LAYOUT_SOURCE, locale: 'en-US', aliasSet: null });

/** 绕过只插入 trigger 直接改 layout 行，模拟改库。 */
async function tamper(db: Db, versionId: string, set: { layout?: string; layoutSha256?: string }) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    if (set.layout !== undefined) {
      await tx.execute(sql`UPDATE "PolicyVersionLayout" SET "layout" = ${set.layout} WHERE "policyVersionId" = ${versionId}`);
    }
    if (set.layoutSha256 !== undefined) {
      await tx.execute(sql`UPDATE "PolicyVersionLayout" SET "layoutSha256" = ${set.layoutSha256} WHERE "policyVersionId" = ${versionId}`);
    }
  });
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('policy-layout store（真实 Postgres）', () => {
  const previous = globalForDb.__asterLocalDevDb;
  const db: Db = createDb(undefined, { max: 3 });

  async function cleanup() {
    // layout 行只能随父版本级联删除
    await db.delete(policyVersions).where(like(policyVersions.id, `${PREFIX}%`));
    await db.delete(policies).where(eq(policies.id, POLICY));
    await db.delete(users).where(eq(users.id, USER));
  }

  beforeAll(async () => {
    globalForDb.__asterLocalDevDb = db;
    await cleanup();
  });
  beforeEach(async () => {
    await cleanup();
    await db.insert(users).values({ id: USER, email: `${USER}@example.test`, updatedAt: new Date() });
    await db.insert(policies).values({ id: POLICY, userId: USER, name: 'layout store', content: LAYOUT_SOURCE, updatedAt: new Date() });
  });
  afterAll(async () => {
    await cleanup();
    globalForDb.__asterLocalDevDb = previous;
    await db.$client.end();
  });

  it('insert then load returns ok with the same layout and hash', async () => {
    const v = await seedVersion(db);
    const p = prepared();
    await db.transaction((tx) => insertVersionLayout(tx, { policyVersionId: v, prepared: p, createdBy: USER }));
    const stored = await loadVersionLayout(v);
    expect(stored).toEqual({ status: 'ok', layout: p.layout, layoutSha256: p.layoutSha256 });
    expect(await activeLayoutSha256(v)).toBe(p.layoutSha256);
  });

  it('no row → none', async () => {
    const v = await seedVersion(db);
    expect(await loadVersionLayout(v)).toEqual({ status: 'none' });
    expect(await activeLayoutSha256(v)).toBeNull();
    expect(await loadVersionLayout(`${PREFIX}missing`)).toEqual({ status: 'none' });
  });

  it('tampered layout text (trigger bypassed with session_replication_role = replica) → inconsistent', async () => {
    const v = await seedVersion(db);
    const p = prepared();
    await db.transaction((tx) => insertVersionLayout(tx, { policyVersionId: v, prepared: p, createdBy: USER }));
    await tamper(db, v, { layout: p.serialized.replace('"display":"\\n"', '"display":"\\n\\n"') });
    expect(await loadVersionLayout(v)).toEqual({ status: 'inconsistent', layoutSha256: p.layoutSha256 });
  });

  it('version content changed after insert → inconsistent', async () => {
    const v = await seedVersion(db);
    const p = prepared();
    await db.transaction((tx) => insertVersionLayout(tx, { policyVersionId: v, prepared: p, createdBy: USER }));
    const changed = LAYOUT_SOURCE.replace('Return amount', 'Return 0');
    await db.update(policyVersions).set({ source: changed, content: changed }).where(eq(policyVersions.id, v));
    expect((await loadVersionLayout(v)).status).toBe('inconsistent');
  });

  it('layout and layoutSha256 both rewritten consistently but canonical differs from content → inconsistent', async () => {
    const v = await seedVersion(db);
    const p = prepared();
    await db.transaction((tx) => insertVersionLayout(tx, { policyVersionId: v, prepared: p, createdBy: USER }));
    // 改的是 canonical 侧：两个哈希列都自洽（sourceSha256 未变、layoutSha256 随文本重算），只有往返复验能发现
    const rewritten = p.serialized.replace('"canonical":".\\n\\n"', '"canonical":".\\n"');
    expect(rewritten).not.toBe(p.serialized);
    await tamper(db, v, { layout: rewritten, layoutSha256: sha256Utf8Hex(rewritten) });
    expect(await loadVersionLayout(v)).toEqual({ status: 'inconsistent', layoutSha256: sha256Utf8Hex(rewritten) });
  });

  it('carry candidate follows Policy.version and verifies the row', async () => {
    const v1 = await seedVersion(db);
    const v2 = await seedVersion(db);
    const p = prepared();
    await db.transaction((tx) => insertVersionLayout(tx, { policyVersionId: v1, prepared: p, createdBy: USER }));

    const versionOf = async (id: string) =>
      (await db.select({ version: policyVersions.version }).from(policyVersions).where(eq(policyVersions.id, id)))[0].version;
    await db.update(policies).set({ version: await versionOf(v1) }).where(eq(policies.id, POLICY));
    expect(await db.transaction((tx) => loadCarryCandidate(tx, POLICY))).toMatchObject({ status: 'ok', layoutSha256: p.layoutSha256 });
    expect(await activeLayoutSha256ForPolicy(POLICY)).toBe(p.layoutSha256);

    await db.update(policies).set({ version: await versionOf(v2) }).where(eq(policies.id, POLICY));
    expect(await db.transaction((tx) => loadCarryCandidate(tx, POLICY))).toEqual({ status: 'none' });
    expect(await activeLayoutSha256ForPolicy(POLICY)).toBeNull();
  });
});
