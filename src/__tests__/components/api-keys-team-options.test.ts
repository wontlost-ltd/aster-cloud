/*
 * API key 作用域下拉的团队选项（ADR 0015 §6）：
 *   - 由页面预取的 membership（带 team 关联）映射为 { id, name }，保持传入顺序
 *   - TeamMember.teamId 无外键：团队行已不存在的悬挂 membership（team 为 null）直接跳过，不能让整页崩溃
 */
import { describe, it, expect } from 'vitest';
import { toTeamOptions } from '@/app/[locale]/(dashboard)/settings/api-keys/team-options';

describe('toTeamOptions', () => {
  it('membership → { id, name }，保持顺序', () => {
    expect(toTeamOptions([
      { team: { id: 't2', name: 'Beta' } },
      { team: { id: 't1', name: 'Alpha' } },
    ])).toEqual([
      { id: 't2', name: 'Beta' },
      { id: 't1', name: 'Alpha' },
    ]);
  });

  it('悬挂 membership（team 为 null）被跳过，不抛错', () => {
    expect(toTeamOptions([
      { team: null },
      { team: { id: 't1', name: 'Alpha' } },
    ])).toEqual([{ id: 't1', name: 'Alpha' }]);
  });

  it('空列表 → 空选项', () => {
    expect(toTeamOptions([])).toEqual([]);
  });
});
