import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PolicyGroupTree, PolicyGroup } from '@/components/policy/policy-group-tree';

const mockTranslations = {
  allPolicies: 'All Policies',
  ungrouped: 'Ungrouped',
  newGroup: 'New Group',
  newSubgroup: 'New Subgroup',
  edit: 'Edit',
  delete: 'Delete',
  policiesCount: '{count} policies',
};

// 默认计数 props
const defaultCountProps = {
  totalPoliciesCount: 10,
  ungroupedCount: 3,
};

const createMockGroup = (overrides: Partial<PolicyGroup> = {}): PolicyGroup => ({
  id: 'group-1',
  name: 'Test Group',
  description: 'Test Description',
  icon: null,
  parentId: null,
  isSystem: false,
  sortOrder: 1,
  children: [],
  _count: { policies: 5 },
  ...overrides,
});

describe('PolicyGroupTree', () => {
  const mockOnSelectGroup = vi.fn();
  const mockOnCreateGroup = vi.fn();
  const mockOnEditGroup = vi.fn();
  const mockOnDeleteGroup = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('should render "All Policies" and "Ungrouped" options', () => {
      render(
        <PolicyGroupTree
          groups={[]}
          selectedGroupId={null}
          onSelectGroup={mockOnSelectGroup}
          translations={mockTranslations}
          {...defaultCountProps}
        />
      );

      expect(screen.getByText('All Policies')).toBeInTheDocument();
      expect(screen.getByText('Ungrouped')).toBeInTheDocument();
    });

    it('should render group list', () => {
      const groups = [
        createMockGroup({ id: 'g1', name: 'Finance' }),
        createMockGroup({ id: 'g2', name: 'Insurance' }),
      ];

      render(
        <PolicyGroupTree
          groups={groups}
          selectedGroupId={null}
          onSelectGroup={mockOnSelectGroup}
          translations={mockTranslations}
          {...defaultCountProps}
        />
      );

      expect(screen.getByText('Finance')).toBeInTheDocument();
      expect(screen.getByText('Insurance')).toBeInTheDocument();
    });

    it('should display policy count for each group', () => {
      const groups = [createMockGroup({ id: 'g1', name: 'Test', _count: { policies: 7 } })];

      render(
        <PolicyGroupTree
          groups={groups}
          selectedGroupId={null}
          onSelectGroup={mockOnSelectGroup}
          translations={mockTranslations}
          {...defaultCountProps}
        />
      );

      // 使用更具体的断言以避免与 totalPoliciesCount 冲突
      expect(screen.getByText('7')).toBeInTheDocument();
    });

    it('should highlight selected "All Policies" option', () => {
      render(
        <PolicyGroupTree
          groups={[]}
          selectedGroupId={null}
          onSelectGroup={mockOnSelectGroup}
          translations={mockTranslations}
          {...defaultCountProps}
        />
      );

      const allPoliciesElement = screen.getByText('All Policies').closest('div');
      expect(allPoliciesElement).toHaveClass('bg-primary-subtle');
    });

    it('should highlight selected group', () => {
      const groups = [createMockGroup({ id: 'g1', name: 'Selected Group' })];

      render(
        <PolicyGroupTree
          groups={groups}
          selectedGroupId="g1"
          onSelectGroup={mockOnSelectGroup}
          translations={mockTranslations}
          {...defaultCountProps}
        />
      );

      const groupElement = screen.getByText('Selected Group').closest('div');
      expect(groupElement).toHaveClass('bg-primary-subtle');
    });
  });

  describe('Selection', () => {
    it('should call onSelectGroup with null when clicking "All Policies"', () => {
      render(
        <PolicyGroupTree
          groups={[]}
          selectedGroupId="g1"
          onSelectGroup={mockOnSelectGroup}
          translations={mockTranslations}
          {...defaultCountProps}
        />
      );

      fireEvent.click(screen.getByText('All Policies'));
      expect(mockOnSelectGroup).toHaveBeenCalledWith(null);
    });

    it('should call onSelectGroup with "ungrouped" when clicking "Ungrouped"', () => {
      render(
        <PolicyGroupTree
          groups={[]}
          selectedGroupId={null}
          onSelectGroup={mockOnSelectGroup}
          translations={mockTranslations}
          {...defaultCountProps}
        />
      );

      fireEvent.click(screen.getByText('Ungrouped'));
      expect(mockOnSelectGroup).toHaveBeenCalledWith('ungrouped');
    });

    it('should call onSelectGroup with group id when clicking a group', () => {
      const groups = [createMockGroup({ id: 'finance-group', name: 'Finance' })];

      render(
        <PolicyGroupTree
          groups={groups}
          selectedGroupId={null}
          onSelectGroup={mockOnSelectGroup}
          translations={mockTranslations}
          {...defaultCountProps}
        />
      );

      fireEvent.click(screen.getByText('Finance'));
      expect(mockOnSelectGroup).toHaveBeenCalledWith('finance-group');
    });
  });

  describe('Expand/Collapse', () => {
    it('should expand group to show children when clicking chevron', () => {
      const childGroup = createMockGroup({ id: 'child-1', name: 'Child Group', parentId: 'parent-1' });
      const parentGroup = createMockGroup({
        id: 'parent-1',
        name: 'Parent Group',
        children: [childGroup],
      });

      render(
        <PolicyGroupTree
          groups={[parentGroup]}
          selectedGroupId={null}
          onSelectGroup={mockOnSelectGroup}
          translations={mockTranslations}
          {...defaultCountProps}
        />
      );

      // 子分组应该不可见
      expect(screen.queryByText('Child Group')).not.toBeInTheDocument();

      // 点击展开
      const parentElement = screen.getByText('Parent Group').closest('div');
      const chevron = parentElement?.querySelector('span');
      if (chevron) {
        fireEvent.click(chevron);
      }

      // 子分组现在应该可见
      expect(screen.getByText('Child Group')).toBeInTheDocument();
    });

    it('should collapse group to hide children when clicking chevron again', () => {
      const childGroup = createMockGroup({ id: 'child-1', name: 'Child Group', parentId: 'parent-1' });
      const parentGroup = createMockGroup({
        id: 'parent-1',
        name: 'Parent Group',
        children: [childGroup],
      });

      render(
        <PolicyGroupTree
          groups={[parentGroup]}
          selectedGroupId={null}
          onSelectGroup={mockOnSelectGroup}
          translations={mockTranslations}
          {...defaultCountProps}
        />
      );

      const parentElement = screen.getByText('Parent Group').closest('div');
      const chevron = parentElement?.querySelector('span');

      // 展开
      if (chevron) {
        fireEvent.click(chevron);
      }
      expect(screen.getByText('Child Group')).toBeInTheDocument();

      // 折叠
      if (chevron) {
        fireEvent.click(chevron);
      }
      expect(screen.queryByText('Child Group')).not.toBeInTheDocument();
    });
  });

  describe('Context Menu', () => {
    it('should show create button when onCreateGroup is provided', () => {
      render(
        <PolicyGroupTree
          groups={[]}
          selectedGroupId={null}
          onSelectGroup={mockOnSelectGroup}
          onCreateGroup={mockOnCreateGroup}
          translations={mockTranslations}
          {...defaultCountProps}
        />
      );

      // 创建按钮应该在标题旁边
      const header = screen.getByText('Groups');
      const createButton = header.parentElement?.querySelector('button');
      expect(createButton).toBeInTheDocument();
    });

    it('should call onCreateGroup with null when clicking header create button', () => {
      render(
        <PolicyGroupTree
          groups={[]}
          selectedGroupId={null}
          onSelectGroup={mockOnSelectGroup}
          onCreateGroup={mockOnCreateGroup}
          translations={mockTranslations}
          {...defaultCountProps}
        />
      );

      const header = screen.getByText('Groups');
      const createButton = header.parentElement?.querySelector('button');
      if (createButton) {
        fireEvent.click(createButton);
      }
      expect(mockOnCreateGroup).toHaveBeenCalledWith(null);
    });

    it('should not show context menu for system groups', () => {
      const systemGroup = createMockGroup({ id: 'system-1', name: 'System Group', isSystem: true });

      render(
        <PolicyGroupTree
          groups={[systemGroup]}
          selectedGroupId={null}
          onSelectGroup={mockOnSelectGroup}
          onEditGroup={mockOnEditGroup}
          onDeleteGroup={mockOnDeleteGroup}
          translations={mockTranslations}
          {...defaultCountProps}
        />
      );

      // 系统分组不应该有上下文菜单按钮
      const groupElement = screen.getByText('System Group').closest('div');
      const menuButton = groupElement?.querySelector('button');
      expect(menuButton).not.toBeInTheDocument();
    });
  });

  // #786：分组操作菜单改用共用 Dropdown（fixed 弹出层，不被侧栏的 overflow-y-auto 裁掉）
  describe('Group actions menu', () => {
    const renderTree = () => render(
      <PolicyGroupTree
        groups={[createMockGroup()]}
        selectedGroupId={null}
        onSelectGroup={mockOnSelectGroup}
        onCreateGroup={mockOnCreateGroup}
        onEditGroup={mockOnEditGroup}
        onDeleteGroup={mockOnDeleteGroup}
        translations={{ ...mockTranslations, actions: 'Actions' }}
        {...defaultCountProps}
      />
    );

    it('has a named disclosure trigger that opens a fixed-position menu without selecting the group', () => {
      renderTree();
      const trigger = screen.getByRole('button', { name: 'Actions: Test Group' });
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      // 键盘聚焦或打开时可见（不是只在悬停时才显示）
      expect(trigger.className).toMatch(/focus-visible:opacity-100/);
      fireEvent.click(trigger);
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(document.querySelector('[data-dropdown-panel]')?.className).toMatch(/\bfixed\b/);
      expect(mockOnSelectGroup).not.toHaveBeenCalled();
    });

    it('items call their handlers, close the menu and do not select the group', () => {
      renderTree();
      fireEvent.click(screen.getByRole('button', { name: 'Actions: Test Group' }));
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      expect(mockOnEditGroup).toHaveBeenCalledWith(expect.objectContaining({ id: 'group-1' }));
      expect(document.querySelector('[data-dropdown-panel]')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Actions: Test Group' }));
      fireEvent.click(screen.getByRole('button', { name: 'New Subgroup' }));
      expect(mockOnCreateGroup).toHaveBeenCalledWith('group-1');
      fireEvent.click(screen.getByRole('button', { name: 'Actions: Test Group' }));
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
      expect(mockOnDeleteGroup).toHaveBeenCalledWith(expect.objectContaining({ id: 'group-1' }));
      expect(mockOnSelectGroup).not.toHaveBeenCalled();
    });
  });

  describe('Create Button', () => {
    it('should not show create button when onCreateGroup is not provided', () => {
      render(
        <PolicyGroupTree
          groups={[]}
          selectedGroupId={null}
          onSelectGroup={mockOnSelectGroup}
          translations={mockTranslations}
          {...defaultCountProps}
        />
      );

      const header = screen.getByText('Groups');
      const createButton = header.parentElement?.querySelector('button');
      expect(createButton).not.toBeInTheDocument();
    });
  });
});
