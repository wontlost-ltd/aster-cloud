// ADR 0065 §3.2：孤儿通知收件人解析，真实 Postgres（Team / TeamMember / User）。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts guard-orphan-notify-recipients

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { like } from 'drizzle-orm';

vi.mock('server-only', () => ({}));

import { createDb } from '@/db';
import { teamMembers, teams, users } from '@/lib/prisma';
import { resolveOrphanRecipients } from '@/lib/guard-orphan-notify/recipients';

const PREFIX = 'it-orphan-rcpt-';
const TEAM = `${PREFIX}team`;

type Db = ReturnType<typeof createDb>;
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

describe.skipIf(process.env.LICENSE_E2E !== '1')('孤儿通知收件人（真实 Postgres）', () => {
  const previous = globalForDb.__asterLocalDevDb;
  const db: Db = createDb(undefined, { max: 4 });

  async function cleanup() {
    await db.delete(teamMembers).where(like(teamMembers.teamId, `${PREFIX}%`));
    await db.delete(teams).where(like(teams.id, `${PREFIX}%`));
    await db.delete(users).where(like(users.id, `${PREFIX}%`));
  }

  const user = (id: string, deletedAt: Date | null = null) =>
    ({ id: `${PREFIX}${id}`, email: `${PREFIX}${id}@example.test`, deletedAt, updatedAt: new Date() }) as typeof users.$inferInsert;
  const member = (id: string, role: 'owner' | 'admin' | 'member' | 'viewer') => ({
    id: `${PREFIX}m-${id}`,
    teamId: TEAM,
    userId: `${PREFIX}${id}`,
    role,
  });

  beforeAll(() => {
    globalForDb.__asterLocalDevDb = db;
  });
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    globalForDb.__asterLocalDevDb = previous;
    await db.$client.end();
  });

  it('团队：只有未删除的 owner / admin 收，已软删的 admin 不收', async () => {
    await db.insert(users).values([
      user('owner'),
      user('admin'),
      user('admin-deleted', new Date()),
      user('member'),
      user('viewer'),
    ]);
    await db.insert(teams).values({ id: TEAM, name: 'Team R', slug: `${PREFIX}slug`, ownerId: `${PREFIX}owner` });
    await db.insert(teamMembers).values([
      member('owner', 'owner'),
      member('admin', 'admin'),
      member('admin-deleted', 'admin'),
      member('member', 'member'),
      member('viewer', 'viewer'),
    ]);
    expect(await resolveOrphanRecipients(TEAM)).toEqual({
      kind: 'team',
      tenantName: 'Team R',
      userIds: [`${PREFIX}admin`, `${PREFIX}owner`],
    });
  });

  it('团队只剩 member：空 userIds', async () => {
    await db.insert(users).values([user('member')]);
    await db.insert(teams).values({ id: TEAM, name: 'Team R', slug: `${PREFIX}slug`, ownerId: `${PREFIX}member` });
    await db.insert(teamMembers).values([member('member', 'member')]);
    expect(await resolveOrphanRecipients(TEAM)).toEqual({ kind: 'team', tenantName: 'Team R', userIds: [] });
  });

  it('个人租户：本人收；已软删则为空；不存在则 unknown', async () => {
    await db.insert(users).values([user('solo'), user('gone', new Date())]);
    expect(await resolveOrphanRecipients(`${PREFIX}solo`)).toEqual({ kind: 'personal', userIds: [`${PREFIX}solo`] });
    expect(await resolveOrphanRecipients(`${PREFIX}gone`)).toEqual({ kind: 'personal', userIds: [] });
    expect(await resolveOrphanRecipients(`${PREFIX}nobody`)).toEqual({ kind: 'unknown' });
  });
});
