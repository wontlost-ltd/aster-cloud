import { extractErrorMessage } from '@/lib/api/error-envelope';
import { TeamPermission, hasPermission, type TeamRole } from '@/lib/team-permission-matrix';

/**
 * 只有具备 INVITATION_VIEW 的角色才请求邀请列表（#588：普通成员也请求，必然 403；
 * 成员页还因此整页报错、看不到成员列表）。
 */
export function canViewInvitations(role: string | null | undefined): boolean {
  return !!role && hasPermission(role as TeamRole, TeamPermission.INVITATION_VIEW);
}

/**
 * 团队详情请求失败时给用户看的文案。非成员与团队不存在一律显示「Team not found」：
 * 本地化、且不暴露团队是否存在（#588：此前原样显示 API 的中文文案「你不是此团队的成员」）。
 */
export function teamLoadError(
  status: number,
  body: unknown,
  t: (key: 'teamNotFound' | 'failedToLoad') => string,
): string {
  const code = (body as { code?: unknown } | null)?.code;
  if (status === 404 || code === 'not_team_member') return t('teamNotFound');
  return extractErrorMessage(body) || t('failedToLoad');
}
