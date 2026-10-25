import { describe, expect, it } from 'vitest';
import { canViewInvitations, teamLoadError } from '@/app/[locale]/(dashboard)/teams/[teamId]/team-fetch';
import { canChangeRole, canInviteWithRole, canRemoveMember } from '@/lib/team-permissions';

const t = (k: 'teamNotFound' | 'failedToLoad') => `t:${k}`;

// #588：非成员看到硬编码中文；普通成员也请求 invitations 得 403（成员页还因此整页报错）
describe('canViewInvitations', () => {
  it.each([['owner', true], ['admin', true], ['member', false], ['viewer', false], [null, false], ['bogus', false]])('%s → %s', (role, expected) => {
    expect(canViewInvitations(role as string | null)).toBe(expected);
  });
});

describe('teamLoadError', () => {
  it('非成员与 404 一律本地化为 Team not found，不透出 API 文案', () => {
    expect(teamLoadError(403, { error: 'You are not a member of this team.', code: 'not_team_member' }, t)).toBe('t:teamNotFound');
    expect(teamLoadError(404, { error: 'Team not found.', code: 'team_not_found' }, t)).toBe('t:teamNotFound');
  });
  it('其它错误沿用 API 文案，缺失时回落到 failedToLoad', () => {
    expect(teamLoadError(500, { error: { code: 'x', message: 'boom' } }, t)).toBe('boom');
    expect(teamLoadError(500, null, t)).toBe('t:failedToLoad');
  });
});

describe('team-permissions 拒绝结果带 code 与英文文案', () => {
  it.each([
    [canChangeRole('admin', 'owner', 'member'), 'cannot_modify_owner'],
    [canChangeRole('owner', 'member', 'owner'), 'cannot_promote_to_owner'],
    [canChangeRole('admin', 'admin', 'member'), 'admin_cannot_modify_admin'],
    [canChangeRole('admin', 'viewer', 'admin'), 'cannot_assign_equal_or_higher_role'],
    [canRemoveMember('owner', 'owner', true), 'owner_cannot_leave'],
    [canRemoveMember('admin', 'owner', false), 'cannot_remove_owner'],
    [canRemoveMember('admin', 'admin', false), 'admin_cannot_remove_admin'],
    [canInviteWithRole('admin', 'owner'), 'cannot_invite_as_owner'],
    [canInviteWithRole('admin', 'admin'), 'cannot_invite_equal_or_higher_role'],
  ])('%#', (result, code) => {
    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.code).toBe(code);
    expect(result.error).toMatch(/^[\x20-\x7E]+$/);
  });
});
