/** API key 作用域下拉中的一个团队选项（ADR 0015 §6） */
export type TeamOption = { id: string; name: string };

/**
 * 页面预取的 membership → 作用域下拉的团队选项，保持传入顺序。
 * TeamMember.teamId 无外键：团队行已删而 membership 残留时关联为 null，这类悬挂行直接跳过，
 * 不能让整个设置页因此崩溃。
 */
export function toTeamOptions(memberships: ReadonlyArray<{ team: TeamOption | null }>): TeamOption[] {
  return memberships.flatMap((m) => (m.team ? [{ id: m.team.id, name: m.team.name }] : []));
}
