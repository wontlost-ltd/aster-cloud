'use client';

import { useState, useMemo, useCallback } from 'react';
import {
  SYNTAX_CATEGORIES,
  SYNTAX_REFERENCE,
  getSyntaxByCategory,
  searchSyntax,
  type SyntaxCategory,
  type SyntaxItem,
} from '@/data/cnl-syntax-reference';
import type { SupportedLocale } from '@/data/policy-examples';

// ============================================
// 图标组件（简化版）
// ============================================

function CategoryIcon({ category, className }: { category: string; className?: string }) {
  const baseClass = className || 'w-4 h-4';

  switch (category) {
    case 'box':
      return (
        <svg className={baseClass} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
        </svg>
      );
    case 'type':
      return (
        <svg className={baseClass} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16m-7 6h7" />
        </svg>
      );
    case 'function':
      return (
        <svg className={baseClass} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
        </svg>
      );
    case 'git-branch':
      return (
        <svg className={baseClass} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7a2 2 0 100-4 2 2 0 000 4zM8 7v6m8 4a2 2 0 100-4 2 2 0 000 4zm0 0V9a2 2 0 00-2-2H8" />
        </svg>
      );
    case 'variable':
      return (
        <svg className={baseClass} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.871 4A17.926 17.926 0 003 12c0 2.874.673 5.59 1.871 8m14.258 0A17.926 17.926 0 0021 12c0-2.874-.673-5.59-1.871-8M9 9h1.246a1 1 0 01.961.725l1.586 5.55a1 1 0 00.961.725H15m-6 0l3-9" />
        </svg>
      );
    case 'calculator':
      return (
        <svg className={baseClass} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
        </svg>
      );
    case 'hash':
      return (
        <svg className={baseClass} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" />
        </svg>
      );
    case 'layers':
      return (
        <svg className={baseClass} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
        </svg>
      );
    default:
      return (
        <svg className={baseClass} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
        </svg>
      );
  }
}

// ============================================
// 语法项卡片组件
// ============================================

interface SyntaxCardProps {
  item: SyntaxItem;
  locale: SupportedLocale;
  compact?: boolean;
}

function SyntaxCard({ item, locale, compact = false }: SyntaxCardProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-bg">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-bg-subtle transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-primary bg-primary-subtle px-1.5 py-0.5 rounded">
            {item.keywords[locale][0]}
          </span>
          {!compact && (
            <span className="text-sm text-fg-muted truncate max-w-[200px]">
              {item.description[locale]}
            </span>
          )}
        </div>
        <svg
          className={`w-4 h-4 text-fg-subtle transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="px-3 py-2 border-t border-border bg-bg-subtle">
          {compact && (
            <p className="text-xs text-fg-muted mb-2">{item.description[locale]}</p>
          )}
          <div className="space-y-1">
            <div className="text-xs text-fg-muted">
              {locale === 'zh-CN' ? '关键字：' : locale === 'de-DE' ? 'Schluesselwoerter:' : 'Keywords:'}
            </div>
            <div className="flex flex-wrap gap-1">
              {item.keywords[locale].map((keyword, idx) => (
                <code
                  key={idx}
                  className="text-xs bg-bg px-1.5 py-0.5 rounded border border-border text-fg"
                >
                  {keyword}
                </code>
              ))}
            </div>
          </div>
          <div className="mt-2">
            <div className="text-xs text-fg-muted mb-1">
              {locale === 'zh-CN' ? '示例：' : locale === 'de-DE' ? 'Beispiel:' : 'Example:'}
            </div>
            {/* R30+ audit P2：从 raw gray ramp 改成 zinc 与 design system 对齐 */}
            <pre tabIndex={0} className="text-xs bg-zinc-900 text-zinc-100 dark:bg-zinc-950 dark:text-zinc-100 p-2 rounded overflow-x-auto whitespace-pre-wrap">
              {item.example[locale]}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================
// 语法参考面板主组件
// ============================================

interface CNLSyntaxReferencePanelProps {
  locale: SupportedLocale;
  uiLocale?: string;
  className?: string;
  defaultExpanded?: boolean;
  compact?: boolean;
}

export function CNLSyntaxReferencePanel({
  locale,
  uiLocale,
  className = '',
  defaultExpanded = false,
  compact = false,
}: CNLSyntaxReferencePanelProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<SyntaxCategory | 'all'>('all');

  const ui = uiLocale?.startsWith('zh') ? 'zh' : uiLocale?.startsWith('de') ? 'de' : 'en';

  // 过滤语法项
  const filteredItems = useMemo(() => {
    let items = SYNTAX_REFERENCE;

    if (searchQuery) {
      items = searchSyntax(searchQuery, locale);
    } else if (selectedCategory !== 'all') {
      items = getSyntaxByCategory(selectedCategory);
    }

    return items;
  }, [searchQuery, selectedCategory, locale]);

  // 按类别分组
  const groupedItems = useMemo(() => {
    if (searchQuery || selectedCategory !== 'all') {
      return [{ category: null, items: filteredItems }];
    }

    return SYNTAX_CATEGORIES.map((cat) => ({
      category: cat,
      items: getSyntaxByCategory(cat.id),
    }));
  }, [filteredItems, searchQuery, selectedCategory]);

  const handleClearSearch = useCallback(() => {
    setSearchQuery('');
    setSelectedCategory('all');
  }, []);

  const titles = {
    en: 'CNL Syntax Reference',
    zh: 'CNL 语法参考',
    de: 'CNL Syntax-Referenz',
  };

  const searchPlaceholders = {
    en: 'Search syntax...',
    zh: '搜索语法...',
    de: 'Syntax suchen...',
  };

  const allCategories = {
    en: 'All',
    zh: '全部',
    de: 'Alle',
  };

  return (
    <div className={`bg-bg border border-border rounded-lg shadow-sm ${className}`}>
      {/* 标题栏 */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-bg-subtle transition-colors rounded-t-lg"
      >
        <div className="flex items-center gap-2">
          <svg className="w-5 h-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
          </svg>
          <span className="font-medium text-fg">{titles[ui]}</span>
          <span className="text-xs text-fg-subtle bg-bg-muted px-1.5 py-0.5 rounded">
            {locale === 'zh-CN' ? '中文' : locale === 'de-DE' ? 'DE' : 'EN'}
          </span>
        </div>
        <svg
          className={`w-5 h-5 text-fg-subtle transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* 展开内容 */}
      {isExpanded && (
        <div className="border-t border-border">
          {/* 搜索和过滤 */}
          <div className="p-3 border-b border-border space-y-2">
            {/* 搜索框 */}
            <div className="relative">
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-subtle"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={searchPlaceholders[ui]}
                className="w-full pl-9 pr-8 py-1.5 text-sm border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={handleClearSearch}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg-muted"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>

            {/* 类别过滤 */}
            {!searchQuery && (
              <div className="flex flex-wrap gap-1">
                <button
                  type="button"
                  onClick={() => setSelectedCategory('all')}
                  className={`text-xs px-2 py-1 rounded-full transition-colors ${
                    selectedCategory === 'all'
                      ? 'bg-primary-subtle text-primary-hover'
                      : 'bg-bg-muted text-fg-muted hover:bg-bg-muted'
                  }`}
                >
                  {allCategories[ui]}
                </button>
                {SYNTAX_CATEGORIES.map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setSelectedCategory(cat.id)}
                    className={`text-xs px-2 py-1 rounded-full transition-colors flex items-center gap-1 ${
                      selectedCategory === cat.id
                        ? 'bg-primary-subtle text-primary-hover'
                        : 'bg-bg-muted text-fg-muted hover:bg-bg-muted'
                    }`}
                  >
                    <CategoryIcon category={cat.icon} className="w-3 h-3" />
                    {cat.name[locale]}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 语法列表 */}
          <div className="p-3 max-h-[400px] overflow-y-auto space-y-3">
            {groupedItems.map((group, groupIdx) => (
              <div key={groupIdx}>
                {group.category && (
                  <div className="flex items-center gap-2 mb-2">
                    <CategoryIcon category={group.category.icon} className="w-4 h-4 text-fg-muted" />
                    <span className="text-sm font-medium text-fg">
                      {group.category.name[locale]}
                    </span>
                  </div>
                )}
                <div className="space-y-1.5">
                  {group.items.map((item, idx) => (
                    <SyntaxCard
                      key={`${groupIdx}-${idx}`}
                      item={item}
                      locale={locale}
                      compact={compact}
                    />
                  ))}
                </div>
              </div>
            ))}

            {filteredItems.length === 0 && (
              <div className="text-center py-8 text-fg-muted text-sm">
                {ui === 'zh' ? '未找到匹配的语法' : ui === 'de' ? 'Keine passende Syntax gefunden' : 'No matching syntax found'}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================
// 紧凑版语法提示组件（用于工具栏）
// ============================================

interface CNLSyntaxHintProps {
  locale: SupportedLocale;
}

export function CNLSyntaxHint({ locale }: CNLSyntaxHintProps) {
  const [isOpen, setIsOpen] = useState(false);

  // 快速提示关键字
  const quickHints = useMemo(() => {
    return SYNTAX_REFERENCE.slice(0, 5).map((item) => ({
      keyword: item.keywords[locale][0],
      description: item.description[locale],
    }));
  }, [locale]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="inline-flex items-center gap-1 px-2 py-1 text-xs text-fg-muted hover:text-primary hover:bg-primary-subtle rounded transition-colors"
        title={locale === 'zh-CN' ? '语法提示' : locale === 'de-DE' ? 'Syntax-Tipps' : 'Syntax hints'}
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span>{locale === 'zh-CN' ? '语法' : 'Syntax'}</span>
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-1 w-64 bg-bg rounded-lg shadow-lg border border-border z-20">
          <div className="p-2 space-y-1">
            {quickHints.map((hint, idx) => (
              <div key={idx} className="flex items-start gap-2 p-1.5 rounded hover:bg-bg-subtle">
                <code className="text-xs text-primary bg-primary-subtle px-1 py-0.5 rounded flex-shrink-0">
                  {hint.keyword}
                </code>
                <span className="text-xs text-fg-muted line-clamp-2">{hint.description}</span>
              </div>
            ))}
          </div>
          <div className="border-t border-border p-2">
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="w-full text-xs text-center text-primary hover:text-primary-hover"
            >
              {locale === 'zh-CN' ? '查看完整参考' : locale === 'de-DE' ? 'Vollstaendige Referenz' : 'View full reference'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
