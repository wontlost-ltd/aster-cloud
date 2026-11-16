'use client';

import { useState, useCallback } from 'react';
import { ChevronRight, ChevronDown, Folder, FolderOpen, Plus, MoreVertical, Pencil, Trash2, FolderPlus } from 'lucide-react';
import { useDroppable } from '@dnd-kit/core';
import { Dropdown, DropdownItem } from '@/components/ui';

export interface PolicyGroup {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  parentId: string | null;
  isSystem: boolean;
  sortOrder: number;
  children: PolicyGroup[];
  _count: {
    policies: number;
  };
}

// 最大分组层级数
const MAX_GROUP_DEPTH = 5;

// 递归计算分组总策略数（包含所有子分组）
function getTotalPoliciesCount(group: PolicyGroup): number {
  let total = group._count.policies;
  if (group.children) {
    for (const child of group.children) {
      total += getTotalPoliciesCount(child);
    }
  }
  return total;
}

interface PolicyGroupTreeProps {
  groups: PolicyGroup[];
  selectedGroupId: string | null;
  onSelectGroup: (groupId: string | null) => void;
  onCreateGroup?: (parentId: string | null) => void;
  onEditGroup?: (group: PolicyGroup) => void;
  onDeleteGroup?: (group: PolicyGroup) => void;
  isDragging?: boolean;
  totalPoliciesCount: number;
  ungroupedCount: number;
  translations: {
    allPolicies: string;
    ungrouped: string;
    newGroup: string;
    newSubgroup: string;
    edit: string;
    delete: string;
    policiesCount: string;
    /** 分组操作菜单按钮的无障碍名前缀（「Actions: <分组名>」）；缺省用英文 */
    actions?: string;
  };
}

// 可放置的分组项包装器
function DroppableGroupItem({
  id,
  children,
  isDragging,
}: {
  id: string;
  children: (isOver: boolean) => React.ReactNode;
  isDragging?: boolean;
}) {
  const { isOver, setNodeRef } = useDroppable({
    id,
    data: { type: 'group', groupId: id },
  });

  return (
    <div
      ref={setNodeRef}
      className={`transition-colors ${
        isDragging && isOver ? 'ring-2 ring-primary ring-inset rounded-md' : ''
      }`}
    >
      {children(isOver)}
    </div>
  );
}

export function PolicyGroupTree({
  groups,
  selectedGroupId,
  onSelectGroup,
  onCreateGroup,
  onEditGroup,
  onDeleteGroup,
  isDragging = false,
  totalPoliciesCount,
  ungroupedCount,
  translations: t,
}: PolicyGroupTreeProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpand = useCallback((groupId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  const renderGroupItem = (group: PolicyGroup, depth: number = 0) => {
    const isExpanded = expandedIds.has(group.id);
    const isSelected = selectedGroupId === group.id;
    const hasChildren = group.children && group.children.length > 0;

    return (
      <DroppableGroupItem key={group.id} id={group.id} isDragging={isDragging}>
        {(isOver) => (
          <>
            <div
              className={`group flex items-center px-2 py-1.5 text-sm rounded-md cursor-pointer transition-colors ${
                isDragging && isOver
                  ? 'bg-primary-subtle text-primary-hover'
                  : isSelected
                  ? 'bg-primary-subtle text-primary-hover'
                  : 'text-fg hover:bg-bg-muted'
              }`}
              style={{ paddingLeft: `${depth * 16 + 8}px` }}
              onClick={() => onSelectGroup(group.id)}
            >
          {/* Expand/Collapse Icon */}
          <span
            className={`flex-shrink-0 w-4 h-4 mr-1 ${hasChildren ? 'cursor-pointer' : ''}`}
            onClick={(e) => hasChildren && toggleExpand(group.id, e)}
          >
            {hasChildren ? (
              isExpanded ? (
                <ChevronDown className="w-4 h-4 text-fg-subtle" />
              ) : (
                <ChevronRight className="w-4 h-4 text-fg-subtle" />
              )
            ) : null}
          </span>

          {/* Folder Icon */}
          {isExpanded && hasChildren ? (
            <FolderOpen className="w-4 h-4 mr-2 text-primary" />
          ) : (
            <Folder className="w-4 h-4 mr-2 text-fg-subtle" />
          )}

          {/* Group Name */}
          <span className="flex-1 truncate">{group.name}</span>

          {/* Policy Count - 显示包含子分组的总数 */}
          <span className="text-xs text-fg-subtle mr-2">
            {getTotalPoliciesCount(group)}
          </span>

          {/* 分组操作菜单：共用 Dropdown（fixed 弹出层，不被侧栏的 overflow-y-auto 裁掉，#786）。
              外层截住点击冒泡，菜单内的点击不会顺带选中该分组。 */}
          {!group.isSystem && (onEditGroup || onDeleteGroup || onCreateGroup) && (
            <div onClick={(e) => e.stopPropagation()} className="flex">
              <Dropdown
                trigger={
                  <button
                    type="button"
                    aria-label={`${t.actions ?? 'Actions'}: ${group.name}`}
                    // 悬停时显示；键盘聚焦或菜单打开时同样显示，不再是看不见的焦点
                    className="p-1 rounded opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 hover:bg-bg-muted"
                  >
                    <MoreVertical className="w-4 h-4 text-fg-muted" aria-hidden="true" />
                  </button>
                }
                className="w-40"
              >
                {/* 最多支持5级分组，第5级不再显示"新建子分组" */}
                {onCreateGroup && depth < MAX_GROUP_DEPTH - 1 && (
                  <DropdownItem onSelect={() => onCreateGroup(group.id)} className="flex items-center">
                    <FolderPlus className="w-4 h-4 mr-2" aria-hidden="true" />
                    {t.newSubgroup}
                  </DropdownItem>
                )}
                {onEditGroup && (
                  <DropdownItem onSelect={() => onEditGroup(group)} className="flex items-center">
                    <Pencil className="w-4 h-4 mr-2" aria-hidden="true" />
                    {t.edit}
                  </DropdownItem>
                )}
                {onDeleteGroup && (
                  <DropdownItem variant="danger" onSelect={() => onDeleteGroup(group)} className="flex items-center">
                    <Trash2 className="w-4 h-4 mr-2" aria-hidden="true" />
                    {t.delete}
                  </DropdownItem>
                )}
              </Dropdown>
            </div>
          )}
        </div>

            {/* Children - 拖拽时自动展开所有子分组以便放置 */}
            {hasChildren && (isExpanded || isDragging) && (
              <div>
                {group.children.map((child) => renderGroupItem(child, depth + 1))}
              </div>
            )}
          </>
        )}
      </DroppableGroupItem>
    );
  };

  return (
    // 移动端（< lg）隐藏分组侧栏：策略分组操作（创建/编辑/拖拽移动）仅桌面端可用。
    // 右侧策略列表 flex-1 自动占满移动端全宽。
    <div className="hidden w-56 flex-shrink-0 border-r border-border bg-bg-subtle overflow-y-auto lg:block">
      <div className="p-3">
        {/* Header with Create Button */}
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-fg-muted uppercase tracking-wider">
            Groups
          </span>
          {onCreateGroup && (
            <button
              className="p-1 rounded hover:bg-bg-muted"
              onClick={() => onCreateGroup(null)}
              title={t.newGroup}
            >
              <Plus className="w-4 h-4 text-fg-muted" />
            </button>
          )}
        </div>

        {/* All Policies */}
        <div
          className={`flex items-center px-2 py-1.5 text-sm rounded-md cursor-pointer transition-colors mb-1 ${
            selectedGroupId === null
              ? 'bg-primary-subtle text-primary-hover'
              : 'text-fg hover:bg-bg-muted'
          }`}
          onClick={() => onSelectGroup(null)}
        >
          <Folder className="w-4 h-4 mr-2 text-fg-subtle" />
          <span className="flex-1">{t.allPolicies}</span>
          <span className="text-xs text-fg-subtle">{totalPoliciesCount}</span>
        </div>

        {/* Ungrouped */}
        <DroppableGroupItem id="ungrouped" isDragging={isDragging}>
          {(isOver) => (
            <div
              className={`flex items-center px-2 py-1.5 text-sm rounded-md cursor-pointer transition-colors mb-2 ${
                isDragging && isOver
                  ? 'bg-primary-subtle text-primary-hover'
                  : selectedGroupId === 'ungrouped'
                  ? 'bg-primary-subtle text-primary-hover'
                  : 'text-fg hover:bg-bg-muted'
              }`}
              onClick={() => onSelectGroup('ungrouped')}
            >
              <Folder className="w-4 h-4 mr-2 text-fg-subtle" />
              <span className="flex-1">{t.ungrouped}</span>
              <span className="text-xs text-fg-subtle">{ungroupedCount}</span>
            </div>
          )}
        </DroppableGroupItem>

        {/* Divider */}
        <div className="border-t border-border my-2" />

        {/* Group Tree */}
        <div className="space-y-0.5">
          {groups.map((group) => renderGroupItem(group, 0))}
        </div>
      </div>
    </div>
  );
}
