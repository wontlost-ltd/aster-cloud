'use client';

import { useEffect, useState } from 'react';
import type { editor } from 'monaco-editor';
import { useTranslations } from 'next-intl';
import {
  Sparkles,
  BookOpen,
  LayoutTemplate,
  AlertTriangle,
  Settings,
  Tags,
  X,
  type LucideIcon,
} from 'lucide-react';
import { AIAssistantPanel } from '@/components/policy/ai-assistant-panel';
import { AiWorkspacePanel } from '@/components/policy/ai-workspace-panel';
import { useSuppressAssistantLauncher } from '@/components/assistant/assistant-context';
import type { AiWorkspaceConfig } from '@/components/ai-workspace-context';
import { CNLSyntaxReferencePanel } from '@/components/policy/cnl-syntax-reference-panel';
import { PolicyAliasPanel } from '@/components/policy/policy-alias-panel';
import type { ReservedSets } from '@/lib/policy-alias-shared';
import { localizedTitle, profileTitle } from '@/services/evidence/control-registry';
import type {
  CompileDiagnostic,
  CompileModuleSummary,
  CompileState,
} from './use-compile';
import { MetaSection } from './meta-section';
import {
  POLICY_EXAMPLES,
  CATEGORY_LABELS,
  type PolicyExample,
  getExampleName,
  getExampleDescription,
  normalizeLocale,
  type SupportedLocale,
} from '@/data/policy-examples';
import { cn } from '@/components/ui';
import { useIsMobile } from './use-is-mobile';
import { VocabularyDiagnosticLink } from '@/components/policy/vocabulary-diagnostic-link';

/** 侧栏容器可见的视口条件，与 index.tsx 中 `lg:flex` 一致。 */
const PANEL_VISIBLE_QUERY = '(min-width: 1024px)';

/**
 * Side panel — tabbed container for AI, syntax reference, and
 * templates. Replaces the three independent collapsibles the old
 * form scattered across the page (each pushing the editor down).
 *
 * The panel itself is a column inside the IDE layout; the parent
 * decides whether to render it (collapsing it via ⌘B is owned by
 * PolicyForm). When mounted, tabs share the height — only one tab
 * is visible at a time.
 *
 * Tab choices:
 *   - AI: generate / repair using the existing AIAssistantPanel.
 *   - Syntax: CNL quick reference, scoped to the active CNL locale.
 *   - Templates: example-driven starter content. PR-1 replaces the
 *     full body but does NOT yet insert at cursor — that's PR-3
 *     and requires the editor's monaco selection API. For now this
 *     behaves like the old dropdown but in a more findable place
 *     with descriptions visible.
 */

export type SidePanelTab =
  | 'settings'
  | 'aliases'
  | 'problems'
  | 'ai'
  | 'syntax'
  | 'templates';

export interface SidePanelProps {
  editor: editor.IStandaloneCodeEditor | null;
  /** 策略的 CNL 语言（规范标签，可能是 hi-IN 等模板/语法参考未覆盖的语言）。 */
  cnlLocale: string;
  uiLocale: string;
  name: string;
  description: string;
  groupId: string | null;
  isPublic: boolean;
  nameError?: string | null;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onGroupIdChange: (value: string | null) => void;
  onIsPublicChange: (value: boolean) => void;
  aliasSet: Record<string, string[]>;
  reservedSets: ReservedSets;
  allowStructuralAliases: boolean;
  onAliasSetChange: (aliasSet: Record<string, string[]>) => void;
  /** Apply a generated/template body to the form's main content. */
  onApplyContent: (content: string) => void;
  /** Apply a template — sets name + description + content together. */
  onApplyTemplate: (template: PolicyExample) => void;
  /** Close the entire side panel (parent collapses it). */
  onClose: () => void;
  /** Compile state from PolicyForm — drives the Decision tab. */
  compileState?: CompileState;
  compileDiagnostics?: CompileDiagnostic[];
  compileModule?: CompileModuleSummary;
  /** Click a diagnostic row → jump to the offending line in Monaco. */
  onJumpToLine?: (line: number, column: number) => void;
  /** Externally request a specific tab (e.g. compile errored → focus
   *  Decision). Optional — if absent, the panel manages its own tab. */
  initialTab?: SidePanelTab;
  /** 当前策略 id；未保存的新策略为 null（工作台面板以 'new' 代替）。 */
  policyId?: string | null;
  /** AI 工作台配置；启用时「AI」tab 嵌入工作台面板，否则沿用原 AIAssistantPanel。 */
  aiWorkspace?: AiWorkspaceConfig | null;
}

export function SidePanel({
  editor,
  cnlLocale,
  uiLocale,
  name,
  description,
  groupId,
  isPublic,
  nameError,
  onNameChange,
  onDescriptionChange,
  onGroupIdChange,
  onIsPublicChange,
  aliasSet,
  reservedSets,
  allowStructuralAliases,
  onAliasSetChange,
  onApplyContent,
  onApplyTemplate,
  onClose,
  compileState,
  compileDiagnostics,
  compileModule,
  onJumpToLine,
  initialTab,
  policyId = null,
  aiWorkspace = null,
}: SidePanelProps) {
  const t = useTranslations('policies.form');
  const [tab, setTab] = useState<SidePanelTab>(initialTab ?? 'ai');
  // Whenever the parent bumps the requested tab (e.g. compile errored),
  // honor it without losing user-selected state otherwise.
  useEffect(() => {
    // 父层 bump initialTab（如编译报错切到 problems）时同步 tab——刻意的
    // prop→state 同步，改掉会丢失父层驱动的切换。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (initialTab) setTab(initialTab);
  }, [initialTab]);
  // AI 工作台面板是否已打开过；未打开过不加载 iframe，避免进入编辑器就提前交接。
  const [aiOpened, setAiOpened] = useState(tab === 'ai');
  if (tab === 'ai' && !aiOpened) setAiOpened(true);
  // 「AI」tab 本身就是 AI 入口，且其输入框/发送按钮贴在视口右下角，正好落在悬浮助手按钮下面：
  // 打开期间让出悬浮按钮，切走或关闭侧栏即恢复。侧栏容器只在 lg 及以上显示（index.tsx 的
  // `hidden lg:flex`），md–lg 之间或窗口缩窄后面板虽挂载却不可见，此时不能让出按钮。
  const panelVisible = useIsMobile(PANEL_VISIBLE_QUERY);
  useSuppressAssistantLauncher(tab === 'ai' && panelVisible);
  const errorCount =
    compileDiagnostics?.filter((d) => d.severity === 'error').length ?? 0;

  // header 标题/图标由当前 tab 派生——与左侧 rail 的图标/文案同源，
  // 保证两处一致（含「决策预览」用 AlertTriangle）。
  const tabMeta: Record<SidePanelTab, { icon: LucideIcon; label: string }> = {
    settings: { icon: Settings, label: t('metaSection') },
    aliases: { icon: Tags, label: t('aliases.title') },
    problems: { icon: AlertTriangle, label: t('decisionPreview') },
    ai: { icon: Sparkles, label: t('sidePanelAI') },
    syntax: { icon: BookOpen, label: t('sidePanelSyntax') },
    templates: { icon: LayoutTemplate, label: t('sidePanelTemplates') },
  };
  const HeaderIcon = tabMeta[tab].icon;
  const headerLabel = tabMeta[tab].label;

  return (
    <aside
      // w-full 关键：抽屉列 `w-[26rem] lg:flex` 是 flex 容器，本 aside 作为 flex
      // item 若无宽度指令会收缩到内在内容宽度（各 tab 内容不同→宽度漂移
      // 249/311/300…）。w-full 强制铺满 26rem 列，各 tab 内容宽度才一致。
      // min-w-0 防未来某个 tab 出现长不可断内容时横向溢出撑破列宽。
      className="flex h-full min-h-0 w-full min-w-0 flex-col rounded-xl border border-border bg-bg shadow-sm"
      aria-label={t('sidePanelToggle')}
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        {/* rail 是主导航（切 tab）；header 只显示当前 tab 标题 + 关闭，消除旧横向 tab
            按钮的宽度不一致（决策预览带角标会撑宽）。 */}
        <div className="flex min-w-0 items-center gap-2">
          <HeaderIcon aria-hidden className="size-4 shrink-0 text-fg-muted" />
          <span className="truncate text-sm font-medium text-fg">{headerLabel}</span>
          {errorCount > 0 && tab === 'problems' && (
            <span className="shrink-0 rounded-full bg-danger px-1.5 py-0.5 text-[10px] font-semibold leading-none text-danger-fg">
              {errorCount}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('sidePanelToggle')}
          className="shrink-0 rounded p-1 text-fg-muted hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:shadow-ring"
        >
          <X aria-hidden className="size-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'settings' && (
          <div className="p-3">
            <MetaSection
              name={name}
              description={description}
              groupId={groupId}
              isPublic={isPublic}
              locale={uiLocale}
              expanded
              // 抽屉 tab 本身就是容器，这里固定展开，避免在抽屉内再折叠。
              onExpandedChange={() => { /* fixed open in the IDE drawer */ }}
              onNameChange={onNameChange}
              onDescriptionChange={onDescriptionChange}
              onGroupIdChange={onGroupIdChange}
              onIsPublicChange={onIsPublicChange}
              nameError={nameError}
            />
          </div>
        )}
        {tab === 'aliases' && (
          <div className="p-3">
            <PolicyAliasPanel
              aliasSet={aliasSet}
              locale={cnlLocale}
              reservedSets={reservedSets}
              allowStructural={allowStructuralAliases}
              onChange={onAliasSetChange}
              expanded
              // 抽屉 tab 本身就是容器，这里固定展开，避免在抽屉内再折叠。
              onExpandedChange={() => { /* fixed open in the IDE drawer */ }}
            />
          </div>
        )}
        {aiWorkspace?.enabled && aiOpened && (
          // 工作台 iframe 首次打开后常驻，切到其他 tab 只隐藏：卸载会重新交接并中断进行中的流式 run
          <div className="h-full" hidden={tab !== 'ai'}>
            <AiWorkspacePanel
              base={aiWorkspace.base}
              policyId={policyId ?? 'new'}
              editor={editor}
              cnlLocale={cnlLocale}
              uiLocale={uiLocale}
              onApplyContent={onApplyContent}
            />
          </div>
        )}
        {tab === 'ai' && !aiWorkspace?.enabled && (
          <div className="p-3">
            <AIAssistantPanel
              editor={editor}
              locale={cnlLocale}
              onApply={onApplyContent}
              // Inside the side panel we don't want the inner X to
              // also close the entire side panel — give it a no-op
              // so it can hide its own dismiss affordance behavior
              // without affecting the parent.
              onClose={() => { /* parent owns close via header X */ }}
            />
          </div>
        )}
        {tab === 'syntax' && (
          <div className="p-3">
            <CNLSyntaxReferencePanel
              locale={normalizeLocale(cnlLocale)}
              uiLocale={uiLocale}
              defaultExpanded
              compact
            />
          </div>
        )}
        {tab === 'templates' && (
          <div className="p-3">
            {/* 与 settings/aliases/ai/syntax 面板一致：统一的全宽卡片容器，
                让「模板/决策预览」内容也填满抽屉宽度、有清晰边界，避免看着比
                「关键词别名」窄。 */}
            <div className="rounded-xl border border-border bg-bg shadow-sm">
              <TemplatesTab
                uiLocale={uiLocale}
                cnlLocale={normalizeLocale(cnlLocale)}
                // Picking a template fully delegates to the parent's
                // template handler — which in PR-3 inserts at cursor
                // rather than wiping the form body. We deliberately
                // don't call onApplyContent here anymore.
                onSelect={onApplyTemplate}
              />
            </div>
          </div>
        )}
        {tab === 'problems' && (
          <div className="p-3">
            <div className="rounded-xl border border-border bg-bg shadow-sm">
              <DecisionTab
                state={compileState}
                diagnostics={compileDiagnostics ?? []}
                module={compileModule}
                locale={uiLocale}
                onJumpToLine={onJumpToLine}
              />
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* Decision tab                                                        */
/* ------------------------------------------------------------------ */

export function DecisionTab({
  state,
  diagnostics,
  module: moduleInfo,
  locale,
  onJumpToLine,
}: {
  state?: CompileState;
  diagnostics: CompileDiagnostic[];
  module?: CompileModuleSummary;
  /** 界面 locale，决定治理档案标题语言。 */
  locale: string;
  onJumpToLine?: (line: number, column: number) => void;
}) {
  const t = useTranslations('policies.form');
  const tDetail = useTranslations('policies.detail');
  // Empty editor / first mount: helpful nudge, not an error.
  // 内容内边距对齐关键词别名/策略信息卡片（px-5 py-5），确保各 tab 内容
  // 从卡片边缘的起始位置一致，视觉上「填满」宽度而非左对齐留白。
  if (!state || state === 'idle') {
    return (
      <div className="px-5 py-5 text-sm text-fg-muted">{t('decisionNone')}</div>
    );
  }
  const errors = diagnostics.filter((d) => d.severity === 'error');
  const warnings = diagnostics.filter((d) => d.severity === 'warning');
  const hasDiagnostics = errors.length > 0 || warnings.length > 0;
  const showModule = !!moduleInfo && errors.length === 0;
  // 编译中、或编译通过但没有模块摘要时，下面两块都不渲染——不能只剩一个标题，
  // 要告诉用户这里会显示什么、何时出现。
  if (!hasDiagnostics && !showModule) {
    return (
      <div className="px-5 py-5 text-sm text-fg-muted">{t('decisionEmpty')}</div>
    );
  }

  return (
    <div className="space-y-4 px-5 py-5">
      {hasDiagnostics && (
        <ul className="space-y-1.5">
          {[...errors, ...warnings].map((d, i) => (
            <li key={`${d.startLine}-${d.startColumn}-${i}`}>
              <button
                type="button"
                onClick={() => onJumpToLine?.(d.startLine, d.startColumn)}
                className={cn(
                  'block w-full rounded-md border px-2.5 py-2 text-left text-xs transition-colors',
                  'focus-visible:outline-none focus-visible:shadow-ring',
                  d.severity === 'error'
                    ? 'border-danger/30 bg-danger/5 text-danger hover:bg-danger/10'
                    : 'border-warning/30 bg-warning/5 text-warning hover:bg-warning/10',
                )}
              >
                <div className="font-mono text-[11px] opacity-70">
                  L{d.startLine}:{d.startColumn}
                  {d.code ? ` · ${d.code}` : ''}
                </div>
                <div className="mt-0.5">{d.message}</div>
              </button>
              {/* 链接放在按钮外：<a> 不能嵌在 <button> 里 */}
              <VocabularyDiagnosticLink code={d.code} message={d.message} className="mt-1 px-2.5" />
            </li>
          ))}
        </ul>
      )}

      {showModule && moduleInfo && (
        <div className="space-y-2 rounded-md border border-border bg-bg-subtle p-3 text-xs">
          <div>
            <span className="font-semibold text-fg">{t('decisionModule')}: </span>
            <span className="font-mono text-fg-muted">{moduleInfo.name}</span>
          </div>
          {/* 治理档案（ADR 0046 §6）：取自浏览器 Core IR，与详情页同一标签与注册表标题 */}
          {moduleInfo.profile && (
            <div>
              <span className="font-semibold text-fg">{tDetail('profile')}: </span>
              <span className="text-fg-muted">{localizedTitle(profileTitle(moduleInfo.profile), locale)}</span>
            </div>
          )}
          {moduleInfo.functions.length > 0 && (
            <div>
              <span className="font-semibold text-fg">
                {t('decisionFunctions')}:{' '}
              </span>
              <span className="font-mono text-fg-muted">
                {moduleInfo.functions.join(', ')}
              </span>
            </div>
          )}
          {moduleInfo.types.length > 0 && (
            <div>
              <span className="font-semibold text-fg">{t('decisionTypes')}: </span>
              <span className="font-mono text-fg-muted">
                {moduleInfo.types.join(', ')}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Templates tab                                                       */
/* ------------------------------------------------------------------ */

function TemplatesTab({
  uiLocale,
  onSelect,
}: {
  uiLocale: string;
  cnlLocale: SupportedLocale;
  onSelect: (t: PolicyExample) => void;
}) {
  const categories = Object.keys(CATEGORY_LABELS) as Array<
    keyof typeof CATEGORY_LABELS
  >;
  // 点击模板会清空并整体替换编辑器内容（非插入到光标）。文案本仓内联三语，
  // 避免为一句提示走 ui-messages 跨仓发版。
  const hint = uiLocale.startsWith('zh')
    ? '点击模板会清空编辑器并替换为该模板内容。'
    : uiLocale.startsWith('de')
      ? 'Ein Klick ersetzt den gesamten Editorinhalt durch die Vorlage.'
      : 'Picking a template clears the editor and replaces its content.';

  return (
    // 内边距对齐关键词别名/策略信息卡片（px-5 py-5），各 tab 内容起始位置一致。
    <div className="space-y-4 px-5 py-5">
      <p className="text-xs text-fg-muted">{hint}</p>
      {categories.map((category) => {
        const items = POLICY_EXAMPLES.filter((e) => e.category === category);
        if (items.length === 0) return null;
        return (
          <div key={category}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
              {CATEGORY_LABELS[category][normalizeLocale(uiLocale)]}
            </h3>
            <ul className="space-y-1">
              {items.map((example) => (
                <li key={example.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(example)}
                    className="w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-bg-subtle focus-visible:outline-none focus-visible:shadow-ring"
                  >
                    <div className="text-sm font-medium text-fg">
                      {getExampleName(example, uiLocale)}
                    </div>
                    <div className="mt-0.5 text-xs text-fg-muted">
                      {getExampleDescription(example, uiLocale)}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
