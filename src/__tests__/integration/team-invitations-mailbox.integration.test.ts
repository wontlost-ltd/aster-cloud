// 团队邀请的邮箱口径（#679 / #682），真实 Postgres。
//
// #679：邀请邮箱入库前统一小写，重复邀请检查忽略大小写（含历史上以原大小写入库的邀请）。
// #682：注册按 emailNormalized 拒绝同一邮箱的 +别名，所以邀请按「同一邮箱」匹配：
//       发给 a+team@x 的邀请可由 a@x 的账号在收件箱看到、接受与拒绝；不同邮箱仍被拒。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts team-invitations-mailbox

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

const session = vi.hoisted(() => ({ userId: 'it-inv-owner' }));
const sent = vi.hoisted(() => ({ calls: [] as Array<{ to: string; team: string; inviter: string }> }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ getSession: vi.fn(async () => ({ user: { id: session.userId } })) }));
vi.mock('@/lib/resend', () => ({
  sendTeamInvitationEmail: vi.fn(async (to: string, team: string, inviter: string) => {
    sent.calls.push({ to, team, inviter });
    return { success: true, inviteUrl: 'http://x/teams/invite?token=t' };
  }),
}));

import { createDb } from '@/db';
import { notifications, teamInvitations, teamMembers, teams, users } from '@/lib/prisma';
import { POST as invite } from '@/app/api/teams/[teamId]/invitations/route';
import { POST as accept } from '@/app/api/teams/invitations/accept/route';
import { POST as decline } from '@/app/api/teams/invitations/decline/route';
import { GET as inbox } from '@/app/api/teams/invitations/inbox/route';

const OWNER = 'it-inv-owner';
const BASE = 'it-inv-base';
const OTHER = 'it-inv-other';
const TEAM = 'it-inv-team';
const USER_IDS = [OWNER, BASE, OTHER];

type Db = ReturnType<typeof createDb>;
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

function json(method: string, body: unknown): Request {
  return new Request('http://localhost/x', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const params = { params: Promise.resolve({ teamId: TEAM }) };

async function cleanup(db: Db): Promise<void> {
  await db.delete(notifications).where(inArray(notifications.userId, USER_IDS));
  await db.delete(teamInvitations).where(eq(teamInvitations.teamId, TEAM));
  await db.delete(teamMembers).where(eq(teamMembers.teamId, TEAM));
  await db.delete(teams).where(eq(teams.id, TEAM));
  await db.delete(users).where(inArray(users.id, USER_IDS));
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('团队邀请邮箱口径（真实 Postgres）', () => {
  const previous = globalForDb.__asterLocalDevDb;
  const db = createDb(undefined, { max: 4 });

  beforeAll(async () => {
    globalForDb.__asterLocalDevDb = db;
    await cleanup(db);
    await db.insert(users).values([
      { id: OWNER, email: 'owner@inv.example', emailNormalized: 'owner@inv.example', plan: 'pro', name: null },
      { id: BASE, email: 'ryan.pang@inv.example', emailNormalized: 'ryan.pang@inv.example', plan: 'free' },
      { id: OTHER, email: 'ryanpang@inv.example', emailNormalized: 'ryanpang@inv.example', plan: 'free' },
    ] as Array<typeof users.$inferInsert>);
    await db.insert(teams).values({ id: TEAM, name: 'Inv Team', slug: 'it-inv-team', ownerId: OWNER });
    await db.insert(teamMembers).values({ id: 'it-inv-m-owner', teamId: TEAM, userId: OWNER, role: 'owner' });
  });

  beforeEach(async () => {
    session.userId = OWNER;
    sent.calls = [];
    await db.delete(teamInvitations).where(eq(teamInvitations.teamId, TEAM));
    await db.delete(teamMembers).where(inArray(teamMembers.userId, [BASE, OTHER]));
    await db.delete(notifications).where(inArray(notifications.userId, USER_IDS));
  });

  afterAll(async () => {
    await cleanup(db);
    globalForDb.__asterLocalDevDb = previous;
  });

  it('#679 邀请邮箱小写入库，换大小写重复邀请返回 400 invitation_already_pending', async () => {
    const first = await invite(json('POST', { email: ' New.Person+ADR@Inv.Example ', role: 'member' }), params);
    expect(first.status).toBe(201);
    expect((await first.json()).email).toBe('new.person+adr@inv.example');

    const dup = await invite(json('POST', { email: 'new.person+adr@INV.example', role: 'member' }), params);
    expect(dup.status).toBe(400);
    expect((await dup.json()).code).toBe('invitation_already_pending');

    const rows = await db.query.teamInvitations.findMany({ where: eq(teamInvitations.teamId, TEAM) });
    expect(rows).toHaveLength(1);
  });

  it('#679 历史上按原大小写入库的待处理邀请同样参与重复检查', async () => {
    await db.insert(teamInvitations).values({
      id: 'it-inv-legacy',
      teamId: TEAM,
      email: 'Legacy.Case@Inv.Example',
      role: 'member',
      token: 'it-inv-legacy-token',
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const dup = await invite(json('POST', { email: 'legacy.case@inv.example', role: 'member' }), params);
    expect(dup.status).toBe(400);
    expect((await dup.json()).code).toBe('invitation_already_pending');
  });

  it('#680 邀请人没有姓名时邮件用邀请人邮箱，而不是硬编码中文', async () => {
    const res = await invite(json('POST', { email: 'someone@inv.example', role: 'viewer' }), params);
    expect(res.status).toBe(201);
    expect(sent.calls[0].inviter).toBe('owner@inv.example');
    expect(sent.calls[0].team).toBe('Inv Team');
  });

  it('#682 发给 +别名的邀请：同一邮箱的账号收到站内通知、在收件箱看到并可接受', async () => {
    const res = await invite(json('POST', { email: 'Ryan.Pang+Team@inv.example', role: 'member' }), params);
    expect(res.status).toBe(201);
    const { id } = await res.json();

    const note = await db.query.notifications.findFirst({ where: eq(notifications.userId, BASE) });
    expect(note?.kind).toBe('team.invitation_received');

    session.userId = BASE;
    const box = await (await inbox()).json();
    expect(box.invitations.map((i: { id: string }) => i.id)).toEqual([id]);

    // 另一个邮箱（local-part 不同）看不到，也接受不了
    session.userId = OTHER;
    expect((await (await inbox()).json()).invitations).toEqual([]);
    const denied = await accept(json('POST', { invitationId: id }));
    expect(denied.status).toBe(403);
    expect((await denied.json()).code).toBe('invitation_email_mismatch');

    session.userId = BASE;
    const ok = await accept(json('POST', { invitationId: id }));
    expect(ok.status).toBe(200);
    const member = await db.query.teamMembers.findFirst({ where: eq(teamMembers.userId, BASE) });
    expect(member?.role).toBe('member');
  });

  it('#682 同一邮箱的账号已是成员时，邀请其 +别名返回 400 already_team_member', async () => {
    await db.insert(teamMembers).values({ id: 'it-inv-m-base', teamId: TEAM, userId: BASE, role: 'member' });
    const res = await invite(json('POST', { email: 'ryan.pang+again@inv.example', role: 'member' }), params);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('already_team_member');
  });

  it('#682 同一邮箱的账号可拒绝发给 +别名的邀请，其他邮箱的拒绝返回 404', async () => {
    const { id } = await (await invite(json('POST', { email: 'ryan.pang+x@inv.example', role: 'member' }), params)).json();

    session.userId = OTHER;
    expect((await decline(json('POST', { invitationId: id }))).status).toBe(404);

    session.userId = BASE;
    expect((await decline(json('POST', { invitationId: id }))).status).toBe(200);
    expect(await db.query.teamInvitations.findFirst({ where: eq(teamInvitations.id, id) })).toBeUndefined();
  });
});
