'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowRight,
  BookOpen,
  Activity,
  LayoutTemplate,
  PanelRight,
  Save,
  SaveAll,
  Search,
  Sparkles,
  WandSparkles,
  Languages,
  Boxes,
  BookMarked,
  Eye,
  SquarePlus,
} from 'lucide-react';
import { cn } from '@/components/ui';
import {
  POLICY_EXAMPLES,
  CATEGORY_LABELS,
  type PolicyExample,
  getExampleName,
  getExampleDescription,
  normalizeLocale,
} from '@/data/policy-examples';

/**
 * In-editor ⌘K command palette.
 *
 * Distinct from the dashboard-wide ⌘K palette (top-nav) — that one
 * jumps routes; this one operates on the current editing session
 * (insert template at cursor, ask AI, format, save, etc.). The
 * parent (PolicyForm) decides when to open this — typically when
 * the user hits ⌘K while the editor has focus.
 *
 * Two-level UX:
 *   - Top level: command list, fuzzy-filtered by typed query.
 *   - Sub-pages: "Insert template" pushes into a template browser
 *     where each row is again clickable + searchable.
 *
 * Keyboard model: ↑/↓ navigate, Enter activates, Esc closes (or
 * pops back to the command list when inside a sub-page).
 */

export type PaletteCommandId =
  | 'ask-ai'
  | 'insert-template' // opens sub-page
  | 'convert-locale'
  | 'format'
  | 'save'
  | 'save-and-view'
  | 'toggle-panel'
  | 'show-syntax'
  | 'show-decision'
  // 以下仅在 structured_authoring 为真时出现（ADR 0058 §8.3）
  | 'open-model-tab'
  | 'open-vocabulary-tab'
  | 'new-struct'
  | 'toggle-canonical-preview';

export type PaletteCommandGroup = 'ai' | 'edit' | 'nav';

export interface PaletteCommand {
  id: PaletteCommandId;
  label: string;
  hint?: string;
  group: PaletteCommandGroup;
  icon: React.ReactNode;
  /** Keyboard shortcut hint (e.g. "⌘S"). */
  shortcut?: string;
}

export interface EditorPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  uiLocale: string;
  onAskAI: () => void;
  onInsertTemplate: (template: PolicyExample) => void;
  onConvertLocale: () => void;
  onFormat: () => void;
  onSave: () => void;
  onSaveAndView: () => void;
  onTogglePanel: () => void;
  onShowSyntax: () => void;
  onShowDecision: () => void;
  /**
   * 结构化编写的命令面板项；只在 structuredAuthoring.allowed 时由父层传入，缺省时面板与接入前一致。
   * onToggleCanonicalPreview 另需 LSP 声明 canonicalPreview，否则为 null（不出现该项）。
   */
  structuredAuthoring?: StructuredAuthoringPaletteActions | null;
}

export interface StructuredAuthoringPaletteActions {
  onOpenModelTab: () => void;
  onOpenVocabularyTab: () => void;
  onNewStruct: () => void;
  onToggleCanonicalPreview: (() => void) | null;
}

type PaletteView = 'commands' | 'templates';

export function EditorPalette({
  isOpen,
  onClose,
  uiLocale,
  onAskAI,
  onInsertTemplate,
  onConvertLocale,
  onFormat,
  onSave,
  onSaveAndView,
  onTogglePanel,
  onShowSyntax,
  onShowDecision,
  structuredAuthoring = null,
}: EditorPaletteProps) {
  const t = useTranslations('policies.form');
  const tPalette = useTranslations('policyEditor.palette');
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [view, setView] = useState<PaletteView>('commands');
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);

  // Reset when reopened so the next session starts at the top.
  useEffect(() => {
    if (isOpen) {
      // isOpen（外部）转为打开时重置面板状态，让下次会话从顶部开始；
      // 条件成立才置位，从 isOpen 派生，非渲染循环。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setView('commands');
      setQuery('');
      setActiveIdx(0);
    }
  }, [isOpen]);

  // Sync open state to the native <dialog>.
  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (isOpen && !dlg.open) {
      dlg.showModal();
      setTimeout(() => inputRef.current?.focus(), 0);
    } else if (!isOpen && dlg.open) {
      dlg.close();
    }
  }, [isOpen]);

  /* --------------------------- commands --------------------------- */

  const commands: PaletteCommand[] = useMemo(
    () => [
      {
        id: 'ask-ai',
        label: t('paletteCmdAskAI'),
        group: 'ai',
        icon: <Sparkles aria-hidden className="size-4" />,
      },
      {
        id: 'insert-template',
        label: t('paletteCmdInsertTemplate'),
        group: 'edit',
        icon: <LayoutTemplate aria-hidden className="size-4" />,
      },
      {
        id: 'convert-locale',
        label: t('paletteCmdConvertLocale'),
        group: 'edit',
        icon: <Languages aria-hidden className="size-4" />,
      },
      {
        id: 'format',
        label: t('paletteCmdFormat'),
        group: 'edit',
        icon: <WandSparkles aria-hidden className="size-4" />,
        shortcut: '⇧⌥F',
      },
      {
        id: 'save',
        label: t('paletteCmdSave'),
        group: 'edit',
        icon: <Save aria-hidden className="size-4" />,
        shortcut: '⌘S',
      },
      {
        id: 'save-and-view',
        label: t('paletteCmdSaveAndView'),
        group: 'edit',
        icon: <SaveAll aria-hidden className="size-4" />,
        shortcut: '⌘↵',
      },
      {
        id: 'toggle-panel',
        label: t('paletteCmdTogglePanel'),
        group: 'nav',
        icon: <PanelRight aria-hidden className="size-4" />,
        shortcut: '⌘B',
      },
      {
        id: 'show-syntax',
        label: t('paletteCmdShowSyntax'),
        group: 'nav',
        icon: <BookOpen aria-hidden className="size-4" />,
      },
      {
        id: 'show-decision',
        label: t('paletteCmdShowDecision'),
        group: 'nav',
        icon: <Activity aria-hidden className="size-4" />,
      },
      ...structuredAuthoringCommands(structuredAuthoring, tPalette),
    ],
    [t, tPalette, structuredAuthoring],
  );

  const filteredCommands = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q));
  }, [commands, query]);

  const grouped = useMemo(() => {
    const out: Record<PaletteCommandGroup, PaletteCommand[]> = {
      ai: [],
      edit: [],
      nav: [],
    };
    for (const c of filteredCommands) out[c.group].push(c);
    return out;
  }, [filteredCommands]);

  // Flat order across groups — used for ↑/↓ + Enter selection.
  const flatCommands = useMemo(
    () => [...grouped.ai, ...grouped.edit, ...grouped.nav],
    [grouped],
  );

  /* --------------------------- templates -------------------------- */

  const filteredTemplates = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return POLICY_EXAMPLES;
    return POLICY_EXAMPLES.filter((tpl) => {
      const hay = (
        getExampleName(tpl, uiLocale) +
        ' ' +
        getExampleDescription(tpl, uiLocale)
      ).toLowerCase();
      return hay.includes(q);
    });
  }, [query, uiLocale]);

  /* --------------------------- activation ------------------------- */

  const activateCommand = useCallback(
    (cmd: PaletteCommand) => {
      switch (cmd.id) {
        case 'ask-ai':
          onAskAI();
          onClose();
          return;
        case 'insert-template':
          setView('templates');
          setQuery('');
          setActiveIdx(0);
          return;
        case 'convert-locale':
          onConvertLocale();
          onClose();
          return;
        case 'format':
          onFormat();
          onClose();
          return;
        case 'save':
          onSave();
          onClose();
          return;
        case 'save-and-view':
          onSaveAndView();
          onClose();
          return;
        case 'toggle-panel':
          onTogglePanel();
          onClose();
          return;
        case 'show-syntax':
          onShowSyntax();
          onClose();
          return;
        case 'show-decision':
          onShowDecision();
          onClose();
          return;
        case 'open-model-tab':
          structuredAuthoring?.onOpenModelTab();
          onClose();
          return;
        case 'open-vocabulary-tab':
          structuredAuthoring?.onOpenVocabularyTab();
          onClose();
          return;
        case 'new-struct':
          structuredAuthoring?.onNewStruct();
          onClose();
          return;
        case 'toggle-canonical-preview':
          structuredAuthoring?.onToggleCanonicalPreview?.();
          onClose();
          return;
      }
    },
    [
      onAskAI,
      onClose,
      onConvertLocale,
      onFormat,
      onSave,
      onSaveAndView,
      onTogglePanel,
      onShowSyntax,
      onShowDecision,
      structuredAuthoring,
    ],
  );

  const activateTemplate = useCallback(
    (tpl: PolicyExample) => {
      onInsertTemplate(tpl);
      onClose();
    },
    [onInsertTemplate, onClose],
  );

  /* --------------------------- key handler ------------------------ */

  const onKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const list =
        view === 'commands' ? flatCommands : filteredTemplates;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, list.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const item = list[activeIdx];
        if (!item) return;
        if (view === 'commands') activateCommand(item as PaletteCommand);
        else activateTemplate(item as PolicyExample);
      } else if (e.key === 'Backspace' && query === '' && view === 'templates') {
        // Pop back to commands when the input is empty.
        e.preventDefault();
        setView('commands');
        setActiveIdx(0);
      } else if (e.key === 'Escape') {
        if (view === 'templates') {
          setView('commands');
          setActiveIdx(0);
          setQuery('');
        }
        // else let the dialog's native close handle it
      }
    },
    [view, flatCommands, filteredTemplates, activeIdx, query, activateCommand, activateTemplate],
  );

  /* --------------------------- render ---------------------------- */

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(e) => {
        // Backdrop click → close (compare currentTarget vs target).
        if (e.target === e.currentTarget) onClose();
      }}
      className={cn(
        'm-0 w-full max-w-xl rounded-xl border border-border bg-bg p-0',
        'shadow-2xl shadow-primary/20',
        'backdrop:bg-zinc-950/40 backdrop:backdrop-blur-sm',
        'fixed left-1/2 top-[20vh] -translate-x-1/2',
      )}
    >
      <div onKeyDown={onKey}>
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Search aria-hidden className="size-4 shrink-0 text-fg-muted" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIdx(0);
            }}
            placeholder={t('palettePlaceholder')}
            className="flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
            autoComplete="off"
            spellCheck={false}
          />
          {view === 'templates' && (
            <button
              type="button"
              onClick={() => {
                setView('commands');
                setQuery('');
                setActiveIdx(0);
              }}
              className="text-xs text-fg-muted hover:text-fg"
            >
              {t('paletteSubBackToCommands')}
            </button>
          )}
          <kbd className="hidden rounded border border-border bg-bg-muted px-1.5 py-0.5 font-mono text-xs text-fg-muted sm:inline-block">
            ESC
          </kbd>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-2">
          {view === 'commands' ? (
            flatCommands.length === 0 ? (
              <EmptyHint text={t('paletteNoResults')} />
            ) : (
              <>
                {(['ai', 'edit', 'nav'] as const).map((group) => {
                  const items = grouped[group];
                  if (items.length === 0) return null;
                  const groupLabel =
                    group === 'ai'
                      ? t('paletteGroupAI')
                      : group === 'edit'
                        ? t('paletteGroupEdit')
                        : t('paletteGroupNav');
                  return (
                    <div key={group} className="py-1">
                      <p className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                        {groupLabel}
                      </p>
                      <ul>
                        {items.map((cmd) => {
                          const flatIdx = flatCommands.indexOf(cmd);
                          const isActive = flatIdx === activeIdx;
                          return (
                            <li key={cmd.id}>
                              <PaletteRow
                                active={isActive}
                                onMouseEnter={() => setActiveIdx(flatIdx)}
                                onClick={() => activateCommand(cmd)}
                                icon={cmd.icon}
                                label={cmd.label}
                                shortcut={cmd.shortcut}
                              />
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })}
              </>
            )
          ) : filteredTemplates.length === 0 ? (
            <EmptyHint text={t('paletteNoResults')} />
          ) : (
            <TemplateList
              items={filteredTemplates}
              activeIdx={activeIdx}
              uiLocale={uiLocale}
              onHover={setActiveIdx}
              onPick={activateTemplate}
            />
          )}
        </div>
      </div>
    </dialog>
  );
}

/* ---------- helpers ---------- */

function EmptyHint({ text }: { text: string }) {
  return (
    <p className="px-3 py-8 text-center text-sm text-fg-muted">{text}</p>
  );
}

function PaletteRow({
  active,
  onMouseEnter,
  onClick,
  icon,
  label,
  shortcut,
}: {
  active: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
}) {
  return (
    <button
      type="button"
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-md px-3 py-2',
        'text-left transition-colors duration-fast',
        active ? 'bg-primary-subtle text-fg' : 'text-fg hover:bg-bg-subtle',
      )}
    >
      <span
        className={cn(
          'shrink-0',
          active ? 'text-primary' : 'text-fg-muted',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        {label}
      </span>
      {shortcut && (
        <kbd className="rounded border border-border bg-bg-muted px-1.5 py-0.5 font-mono text-[11px] text-fg-muted">
          {shortcut}
        </kbd>
      )}
      {active && (
        <ArrowRight aria-hidden className="size-3.5 text-primary" />
      )}
    </button>
  );
}

function TemplateList({
  items,
  activeIdx,
  uiLocale,
  onHover,
  onPick,
}: {
  items: PolicyExample[];
  activeIdx: number;
  uiLocale: string;
  onHover: (i: number) => void;
  onPick: (tpl: PolicyExample) => void;
}) {
  // Group by category so the picker reads as a structured menu, not
  // a flat list.
  const byCategory = useMemo(() => {
    const out = new Map<string, PolicyExample[]>();
    for (const tpl of items) {
      const list = out.get(tpl.category) ?? [];
      list.push(tpl);
      out.set(tpl.category, list);
    }
    return out;
  }, [items]);

  let flatIdx = -1;
  return (
    <>
      {(Object.keys(CATEGORY_LABELS) as Array<keyof typeof CATEGORY_LABELS>).map(
        (category) => {
          const list = byCategory.get(category) ?? [];
          if (list.length === 0) return null;
          return (
            <div key={category} className="py-1">
              <p className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                {CATEGORY_LABELS[category][normalizeLocale(uiLocale)]}
              </p>
              <ul>
                {list.map((tpl) => {
                  flatIdx += 1;
                  const isActive = flatIdx === activeIdx;
                  const capturedIdx = flatIdx;
                  return (
                    <li key={tpl.id}>
                      <button
                        type="button"
                        onMouseEnter={() => onHover(capturedIdx)}
                        onClick={() => onPick(tpl)}
                        className={cn(
                          'flex w-full items-start gap-3 rounded-md px-3 py-2 text-left',
                          'transition-colors duration-fast',
                          isActive
                            ? 'bg-primary-subtle'
                            : 'hover:bg-bg-subtle',
                        )}
                      >
                        <LayoutTemplate
                          aria-hidden
                          className={cn(
                            'mt-0.5 size-4 shrink-0',
                            isActive ? 'text-primary' : 'text-fg-muted',
                          )}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-fg">
                            {getExampleName(tpl, uiLocale)}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-fg-muted">
                            {getExampleDescription(tpl, uiLocale)}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        },
      )}
    </>
  );
}

/** 结构化编写的面板项：无权时为空，面板与接入前逐项一致。 */
function structuredAuthoringCommands(
  actions: StructuredAuthoringPaletteActions | null,
  labelOf: (key: 'openModelTab' | 'openVocabularyTab' | 'newStruct' | 'toggleCanonicalPreview') => string,
): PaletteCommand[] {
  if (!actions) return [];
  const commands: PaletteCommand[] = [
    { id: 'new-struct', label: labelOf('newStruct'), group: 'edit', icon: <SquarePlus aria-hidden className="size-4" /> },
    { id: 'open-model-tab', label: labelOf('openModelTab'), group: 'nav', icon: <Boxes aria-hidden className="size-4" /> },
    { id: 'open-vocabulary-tab', label: labelOf('openVocabularyTab'), group: 'nav', icon: <BookMarked aria-hidden className="size-4" /> },
  ];
  if (actions.onToggleCanonicalPreview) {
    commands.push({
      id: 'toggle-canonical-preview',
      label: labelOf('toggleCanonicalPreview'),
      group: 'nav',
      icon: <Eye aria-hidden className="size-4" />,
    });
  }
  return commands;
}
