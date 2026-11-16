// @vitest-environment jsdom
/**
 * #774：分组选择按钮的可访问名称须包含按钮上可见的文字（WCAG 2.5.3 Label in Name）。
 * 此前 aria-label="Group" 覆盖了可见的「Ungrouped」/ 分组名，axe 报 label-content-name-mismatch。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PolicyGroupSelect } from '@/components/policy/policy-group-select';

const groups = [{ id: 'g1', name: 'Lending', parentId: null, children: [] }];

describe('PolicyGroupSelect accessible name (#774)', () => {
  it('combines the label with the visible placeholder', () => {
    render(<PolicyGroupSelect value={null} onChange={() => undefined} groups={groups as never} label="Group" placeholder="Ungrouped" />);
    expect(screen.getByRole('button', { name: 'Group Ungrouped' })).toBeTruthy();
  });

  it('combines the label with the visible selected group name', () => {
    render(<PolicyGroupSelect value="g1" onChange={() => undefined} groups={groups as never} label="Group" placeholder="Ungrouped" />);
    expect(screen.getByRole('button', { name: /^Group\s+Lending$/ })).toBeTruthy();
  });

  it('uses the visible text when there is no label', () => {
    render(<PolicyGroupSelect value={null} onChange={() => undefined} groups={groups as never} placeholder="Ungrouped" />);
    expect(screen.getByRole('button', { name: 'Ungrouped' })).toBeTruthy();
  });
});
