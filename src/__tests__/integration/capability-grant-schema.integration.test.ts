// ADR 0058 §4.2：CapabilityGrant / CapabilityTeamAllotment 表约束，真实 Postgres。
// 验证 CHECK（主体互斥、委派一致、来源枚举、备注长度、名额范围）与两条活跃唯一索引的行为。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts capability-grant-schema

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inArray, like } from 'drizzle-orm';

import { createDb } from '@/db';
import { capabilityGrants, capabilityTeamAllotments, users } from '@/lib/prisma';

const PREFIX = 'it-capgrant-';
const USER_A = `${PREFIX}user-a`;
const USER_B = `${PREFIX}user-b`;
const TEAM = `${PREFIX}team-1`;
const CAP = 'structured_authoring';

type Db = ReturnType<typeof createDb>;
type GrantInsert = typeof capabilityGrants.$inferInsert;

let seq = 0;
function grant(overrides: Partial<GrantInsert>): GrantInsert {
  return {
    id: `${PREFIX}g-${++seq}`,
    capability: CAP,
    source: 'platform_admin',
    ...overrides,
  };
}

/** 取出 drizzle 包装错误里 Postgres 的原始报错文本，便于断言约束名。 */
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string; constraint_name?: string } };
    return `${err.message ?? ''} ${err.cause?.message ?? ''} ${err.cause?.constraint_name ?? ''}`;
  }
  throw new Error('期望写入被拒绝，但成功了');
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('CapabilityGrant 表约束（真实 Postgres）', () => {
  const db: Db = createDb(undefined, { max: 2 });

  async function cleanup() {
    await db.delete(capabilityGrants).where(like(capabilityGrants.id, `${PREFIX}%`));
    await db.delete(capabilityTeamAllotments).where(like(capabilityTeamAllotments.teamId, `${PREFIX}%`));
  }

  beforeAll(async () => {
    await cleanup();
    await db.delete(users).where(inArray(users.id, [USER_A, USER_B]));
    await db.insert(users).values(
      [USER_A, USER_B].map((id) => ({ id, email: `${id}@example.test`, updatedAt: new Date() })) as Array<
        typeof users.$inferInsert
      >,
    );
  });

  beforeEach(cleanup);

  afterAll(async () => {
    await cleanup();
    await db.delete(users).where(inArray(users.id, [USER_A, USER_B]));
  });

  it('rejects a row with both userId and teamId', async () => {
    const msg = await rejection(db.insert(capabilityGrants).values(grant({ userId: USER_A, teamId: TEAM })));
    expect(msg).toContain('CapabilityGrant_subject_ck');
  });

  it('rejects a row with neither userId nor teamId', async () => {
    const msg = await rejection(db.insert(capabilityGrants).values(grant({})));
    expect(msg).toContain('CapabilityGrant_subject_ck');
  });

  it('rejects team_owner source without delegatingTeamId', async () => {
    const msg = await rejection(
      db.insert(capabilityGrants).values(grant({ userId: USER_A, source: 'team_owner' })),
    );
    expect(msg).toContain('CapabilityGrant_delegation_ck');
  });

  it('rejects delegatingTeamId on a team subject', async () => {
    const msg = await rejection(
      db.insert(capabilityGrants).values(grant({ teamId: TEAM, source: 'team_owner', delegatingTeamId: TEAM })),
    );
    expect(msg).toContain('CapabilityGrant_delegation_ck');
  });

  it('rejects delegatingTeamId on a non team_owner source', async () => {
    const msg = await rejection(
      db.insert(capabilityGrants).values(grant({ userId: USER_A, delegatingTeamId: TEAM })),
    );
    expect(msg).toContain('CapabilityGrant_delegation_ck');
  });

  it('rejects unknown source and over-long note', async () => {
    const src = await rejection(db.insert(capabilityGrants).values(grant({ userId: USER_A, source: 'bogus' })));
    expect(src).toContain('CapabilityGrant_source_ck');
    const note = await rejection(
      db.insert(capabilityGrants).values(grant({ userId: USER_A, note: 'x'.repeat(501) })),
    );
    expect(note).toContain('CapabilityGrant_note_len_ck');
    await db.insert(capabilityGrants).values(grant({ userId: USER_A, note: 'x'.repeat(500) }));
  });

  it('second active grant for same (capability,userId,null delegation) violates unique; revoked one does not', async () => {
    const first = grant({ userId: USER_A });
    await db.insert(capabilityGrants).values(first);
    const dup = await rejection(db.insert(capabilityGrants).values(grant({ userId: USER_A })));
    expect(dup).toContain('CapabilityGrant_active_user_unique');

    await db.update(capabilityGrants).set({ revokedAt: new Date(), revokeReason: 'manual' });
    await db.insert(capabilityGrants).values(grant({ userId: USER_A }));
    // 撤销行可以有多条
    await db.insert(capabilityGrants).values(grant({ userId: USER_A, revokedAt: new Date() }));
  });

  it('second active team grant violates unique', async () => {
    await db.insert(capabilityGrants).values(grant({ teamId: TEAM }));
    const dup = await rejection(db.insert(capabilityGrants).values(grant({ teamId: TEAM })));
    expect(dup).toContain('CapabilityGrant_active_team_unique');
  });

  it('user grant and delegated grant for same user coexist', async () => {
    await db.insert(capabilityGrants).values(grant({ userId: USER_A }));
    await db
      .insert(capabilityGrants)
      .values(grant({ userId: USER_A, source: 'team_owner', delegatingTeamId: TEAM }));
    const dup = await rejection(
      db.insert(capabilityGrants).values(grant({ userId: USER_A, source: 'team_owner', delegatingTeamId: TEAM })),
    );
    expect(dup).toContain('CapabilityGrant_active_user_unique');
  });

  it('seatCap 10001 rejected, 0 and 10000 accepted', async () => {
    const over = await rejection(
      db.insert(capabilityTeamAllotments).values({ capability: CAP, teamId: `${PREFIX}t-over`, seatCap: 10001 }),
    );
    expect(over).toContain('CapabilityTeamAllotment_seatCap_ck');
    const neg = await rejection(
      db.insert(capabilityTeamAllotments).values({ capability: CAP, teamId: `${PREFIX}t-neg`, seatCap: -1 }),
    );
    expect(neg).toContain('CapabilityTeamAllotment_seatCap_ck');
    await db.insert(capabilityTeamAllotments).values([
      { capability: CAP, teamId: `${PREFIX}t-0`, seatCap: 0 },
      { capability: CAP, teamId: `${PREFIX}t-max`, seatCap: 10000 },
    ]);
    const rows = await db.select().from(capabilityTeamAllotments).where(like(capabilityTeamAllotments.teamId, `${PREFIX}t-%`));
    expect(rows.every((r) => r.ownerGrantingEnabled === true)).toBe(true);
  });
});
