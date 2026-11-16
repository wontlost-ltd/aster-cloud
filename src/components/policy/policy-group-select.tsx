'use client';

import { useState, useEffect, useId, useRef } from 'react';
import { ChevronDown, Folder, Check, X } from 'lucide-react';

interface PolicyGroup {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  parentId: string | null;
  isSystem: boolean;
  sortOrder: number;
  children?: PolicyGroup[];
  _count?: {
    policies: number;
  };
}

interface PolicyGroupSelectProps {
  value: string | null;
  onChange: (groupId: string | null) => void;
  groups?: PolicyGroup[];
  placeholder?: string;
  label?: string;
  className?: string;
  disabled?: boolean;
}

// 纯函数：把树形分组拍平成一维数组便于 id 查找。无闭包依赖（只用入参），
// 提到模块级消除「在声明前使用」错误，并让 effect 内引用稳定。
function flattenGroups(groups: PolicyGroup[]): PolicyGroup[] {
  const result: PolicyGroup[] = [];
  const flatten = (items: PolicyGroup[]) => {
    for (const item of items) {
      result.push(item);
      if (item.children && item.children.length > 0) {
        flatten(item.children);
      }
    }
  };
  flatten(groups);
  return result;
}

export function PolicyGroupSelect({
  value,
  onChange,
  groups: externalGroups,
  placeholder = 'Select a group...',
  label,
  className = '',
  disabled = false,
}: PolicyGroupSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [groups, setGroups] = useState<PolicyGroup[]>(externalGroups || []);
  const [flatGroups, setFlatGroups] = useState<PolicyGroup[]>([]);
  const [isLoading, setIsLoading] = useState(!externalGroups);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // 可访问名称 = 标签 + 按钮上可见的当前值（WCAG 2.5.3 Label in Name：名称须包含可见文字，#774）
  const labelId = useId();
  const valueId = useId();

  // Fetch groups if not provided externally
  useEffect(() => {
    if (externalGroups) {
      // externalGroups（prop）变化时同步内部缓存——刻意的 prop→state 同步，
      // 条件成立才置位，非渲染循环。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setGroups(externalGroups);
      setFlatGroups(flattenGroups(externalGroups));
      setIsLoading(false);
      return;
    }

    const fetchGroups = async () => {
      try {
        const res = await fetch('/api/policy-groups');
        if (!res.ok) throw new Error('Failed to fetch groups');
        const data = await res.json();
        setGroups(data.groups || []);
        setFlatGroups(data.flatGroups || flattenGroups(data.groups || []));
      } catch (error) {
        console.error('Error fetching groups:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchGroups();
  }, [externalGroups]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Find selected group
  const selectedGroup = value ? flatGroups.find((g) => g.id === value) : null;

  // Render group item with indentation for hierarchy
  const renderGroupItem = (group: PolicyGroup, depth: number = 0) => {
    const isSelected = value === group.id;

    return (
      <div key={group.id}>
        <button
          type="button"
          className={`w-full flex items-center px-3 py-2 text-sm transition-colors ${
            isSelected
              ? 'bg-primary-subtle text-primary-hover'
              : 'text-fg hover:bg-bg-subtle'
          }`}
          style={{ paddingLeft: `${depth * 16 + 12}px` }}
          onClick={() => {
            onChange(group.id);
            setIsOpen(false);
          }}
        >
          <Folder className="w-4 h-4 mr-2 text-fg-subtle flex-shrink-0" />
          <span className="flex-1 text-left truncate">{group.name}</span>
          {group._count && (
            <span className="text-xs text-fg-subtle ml-2">{group._count.policies}</span>
          )}
          {isSelected && <Check className="w-4 h-4 ml-2 text-primary flex-shrink-0" />}
        </button>
        {group.children && group.children.length > 0 && (
          <div>
            {group.children.map((child) => renderGroupItem(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={`relative ${className}`} ref={dropdownRef}>
      {label && (
        <label id={labelId} className="block text-sm font-semibold text-fg mb-2">
          {label}
        </label>
      )}

      {/* Select Button */}
      {/* aria-haspopup + aria-expanded so screen readers report dropdown
          state. 名称由标签与可见的当前值（或占位文字）组成；此前用 aria-label 覆盖成单纯的「Group」，
          与按钮上可见的文字不一致（axe label-content-name-mismatch，#774）。 */}
      <button
        type="button"
        disabled={disabled || isLoading}
        onClick={() => setIsOpen(!isOpen)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-labelledby={label ? `${labelId} ${valueId}` : undefined}
        className={`
          w-full flex items-center justify-between rounded-lg border bg-bg px-4 py-3 text-left shadow-sm transition-all duration-200
          ${disabled
            ? 'border-border bg-bg-subtle cursor-not-allowed'
            : isOpen
              ? 'border-primary ring-2 ring-primary/20'
              : 'border-border-strong hover:border-gray-400'
          }
        `}
      >
        <div id={valueId} className="flex items-center flex-1 min-w-0">
          {isLoading ? (
            <span className="text-fg-subtle text-sm">Loading...</span>
          ) : selectedGroup ? (
            <>
              <Folder className="w-4 h-4 mr-2 text-primary flex-shrink-0" />
              <span className="text-fg text-sm truncate">{selectedGroup.name}</span>
            </>
          ) : (
            <span className="text-fg-subtle text-sm">{placeholder}</span>
          )}
        </div>

        <div className="flex items-center ml-2 flex-shrink-0">
          {/* Clear button */}
          {selectedGroup && !disabled && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onChange(null);
              }}
              className="p-1 rounded hover:bg-bg-muted mr-1"
            >
              <X className="w-4 h-4 text-fg-subtle" />
            </button>
          )}
          <ChevronDown
            className={`w-4 h-4 text-fg-subtle transition-transform ${isOpen ? 'rotate-180' : ''}`}
          />
        </div>
      </button>

      {/* Dropdown */}
      {isOpen && !disabled && (
        <div className="absolute z-20 mt-2 w-full bg-bg rounded-lg shadow-lg border border-border max-h-64 overflow-y-auto">
          {/* Ungrouped option */}
          <button
            type="button"
            className={`w-full flex items-center px-3 py-2 text-sm transition-colors ${
              value === null
                ? 'bg-primary-subtle text-primary-hover'
                : 'text-fg hover:bg-bg-subtle'
            }`}
            onClick={() => {
              onChange(null);
              setIsOpen(false);
            }}
          >
            <Folder className="w-4 h-4 mr-2 text-fg-subtle" />
            <span className="flex-1 text-left">No group (Ungrouped)</span>
            {value === null && <Check className="w-4 h-4 ml-2 text-primary" />}
          </button>

          {/* Divider */}
          {groups.length > 0 && <div className="border-t border-border my-1" />}

          {/* Groups */}
          {groups.map((group) => renderGroupItem(group, 0))}

          {/* Empty state */}
          {groups.length === 0 && !isLoading && (
            <div className="px-3 py-4 text-center text-sm text-fg-muted">
              No groups available
            </div>
          )}
        </div>
      )}
    </div>
  );
}
