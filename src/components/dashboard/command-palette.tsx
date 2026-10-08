/**
 * Cmd+K (⌘K / Ctrl+K) command palette for the dashboard.
 *
 * Why this exists: every product surface in aster-cloud is one of <50
 * routes. Users navigate constantly between Policies / Settings / Billing
 * / Teams. A keyboard-driven palette beats clicking around the top-nav
 * for power users, and signals "this is a serious product" to the kind
 * of operator who's the buyer.
 *
 * Why not cmdk / kbar / radix-cmd: those packages each pull in 10-30KB of
 * combobox/portal/listbox machinery and tightly couple us to their
 * keyboard models. The whole feature is ~150 LOC of plain React +
 * useEffect listeners + a `<dialog>` polyfill-less native element. Less
 * dependency surface, more brand control, easier to tweak.
 *
 * Layout: portal-less native `<dialog>` mounted at body level via
 * createPortal isn't needed because the dialog uses `position: fixed`
 * with z-50 already. The native open/close is intentional — accessibility
 * for free (Esc to close, focus trap, role=dialog).
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { track, Events } from '@/lib/mixpanel';
import {
  ArrowRight,
  BookText,
  ClipboardCheck,
  FileText,
  Home,
  KeyRound,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Users,
  Wallet,
} from 'lucide-react';
import { cn } from '@/components/ui';
import type { Command, CommandIcon } from './command-palette-commands';

// Map icon id (string, RSC-serializable) → Lucide component. Kept on
// the client side so Server Components don't have to send forwardRef
// values across the RSC boundary.
const ICONS: Record<CommandIcon, React.ComponentType<{ className?: string }>> = {
  'home':         Home,
  'file-text':    FileText,
  'users':        Users,
  'shield-check': ShieldCheck,
  'sparkles':     Sparkles,
  'wallet':       Wallet,
  'settings':     Settings,
  'key-round':    KeyRound,
  'book-text':    BookText,
  'clipboard-check': ClipboardCheck,
};

// Note: buildCommands + types live in command-palette-commands.ts (no
// 'use client'). Server Components must import them from that module
// directly — re-exporting them from this file would drag them back
// across the client boundary and break server-side invocation.

/* ------------------------------------------------------------------ */
/* Palette component                                                   */
/* ------------------------------------------------------------------ */

export interface CommandPaletteProps {
  /** All commands the palette should expose. Built in the layout from
   *  the same nav-item array that drives the top-nav links — see
   *  layout.tsx for the call site. */
  commands: Command[];
  /** Localized strings — keeps the palette i18n-pure. */
  labels: {
    placeholder: string;       // e.g. "Search or jump to…"
    noResults: string;         // e.g. "No matches"
    groupNavigate: string;
    groupCreate: string;
    groupSettings: string;
    /** Header for docs entries seeded from the build-time search index. */
    groupDocs: string;
    hintOpen: string;          // e.g. "Press ⌘K to open"
  };
}

export function CommandPalette({ commands, labels }: CommandPaletteProps) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);

  /* ---- Open / close mechanics ---- */

  const openPalette = useCallback((trigger: 'click' | 'keyboard' = 'click') => {
    setOpen(true);
    setQuery('');
    setActiveIdx(0);
    // Analytics: how often the palette is opened tells us whether the
    // discovery affordance is paying off. Mixpanel calls are no-ops when
    // the token isn't configured (e.g. local dev without secrets) so
    // gating here is unnecessary.
    track(Events.PALETTE_OPENED, { trigger });
  }, []);

  const closePalette = useCallback(() => {
    setOpen(false);
    // Native dialog.close() avoids leftover backdrop state.
    dialogRef.current?.close();
  }, []);

  /** Wrap router.push so click + Enter both report the same selection event. */
  const selectCommand = useCallback(
    (cmd: Command, trigger: 'click' | 'enter') => {
      track(Events.PALETTE_COMMAND_SELECTED, {
        command_id: cmd.id,
        command_group: cmd.group,
        // Whether the user typed to filter — distinguishes "browse" from "search".
        had_query: query.trim().length > 0,
        trigger,
      });
      closePalette();
      router.push(cmd.href);
    },
    [closePalette, query, router],
  );

  // Global Cmd+K / Ctrl+K listener — mounted once at layout level.
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // Ignore if user is typing in a non-palette input (don't hijack
      // password fields). Heuristic: the dialog's own input has data-cmdk.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName.toLowerCase();
      const isTyping =
        tag === 'input' || tag === 'textarea' || target?.isContentEditable;
      const isOurInput = target?.hasAttribute('data-cmdk');

      // Cmd+K on Mac, Ctrl+K everywhere else.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        if (!isTyping || isOurInput) {
          e.preventDefault();
          // Stop the event so a globally-mounted docs palette (Phase 5)
          // doesn't ALSO open on the same shortcut. Inside the
          // dashboard surface the user's Cmd+K is for app commands;
          // docs entries are surfaced as a group inside this palette
          // already (see `docsSeeds` in buildCommands).
          e.stopPropagation();
          if (open) closePalette();
          else openPalette('keyboard');
        }
      }
    };
    // `capture: true` runs this listener BEFORE bubble-phase listeners
    // such as the docs palette's. Combined with stopPropagation() above
    // we guarantee the dashboard palette wins when both are mounted
    // (e.g. on a /dashboard route that also has the global docs
    // palette from Phase 5).
    window.addEventListener('keydown', handleKey, { capture: true });
    return () =>
      window.removeEventListener('keydown', handleKey, { capture: true });
  }, [open, openPalette, closePalette]);

  // Open/close the native <dialog> in sync with React state.
  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (open && !dlg.open) {
      dlg.showModal();
      // Defer focus so the dialog has actually mounted in DOM.
      setTimeout(() => inputRef.current?.focus(), 0);
    } else if (!open && dlg.open) {
      dlg.close();
    }
  }, [open]);

  /* ---- Filtering ---- */

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => {
      const haystack = [c.label, c.hint, ...(c.keywords ?? [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [commands, query]);

  // Reset active index whenever the result set shrinks under it.
  useEffect(() => {
    // 结果集缩小到当前选中项之下时把高亮索引钳回 0——有越界守卫，非每渲染无条件触发，属合法的状态钳制。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (activeIdx >= filtered.length) setActiveIdx(0);
  }, [filtered.length, activeIdx]);

  /* ---- Keyboard navigation (arrow keys + Enter) ---- */

  const onListKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = filtered[activeIdx];
        if (cmd) {
          selectCommand(cmd, 'enter');
        }
      }
    },
    [filtered, activeIdx, selectCommand],
  );

  /* ---- Grouping (preserve catalog order within group) ---- */

  const grouped = useMemo(() => {
    const groups: Record<Command['group'], Command[]> = {
      navigate: [],
      create: [],
      settings: [],
      docs: [],
    };
    for (const c of filtered) groups[c.group].push(c);
    return groups;
  }, [filtered]);

  // Build a flat index lookup so activeIdx maps to the right grouped item.
  const flatList = filtered;

  return (
    <>
      {/* The trigger button — discoverable for users who don't know about
          Cmd+K. Rendered in the top-nav (see layout.tsx). Exporting a
          separate Trigger component avoids passing a ref or context. */}
      <dialog
        ref={dialogRef}
        onClose={() => setOpen(false)}
        onClick={(e) => {
          // Click on the backdrop (the dialog itself) closes; click inside
          // the panel doesn't bubble. Compare currentTarget === target.
          if (e.target === e.currentTarget) closePalette();
        }}
        className={cn(
          'm-0 w-full max-w-xl rounded-xl border border-border bg-bg p-0',
          'shadow-2xl shadow-primary/20',
          'backdrop:bg-zinc-950/40 backdrop:backdrop-blur-sm',
          // Center via fixed-positioning since the native modal centering
          // on Chrome/Firefox/Safari is inconsistent.
          'fixed left-1/2 top-[20vh] -translate-x-1/2',
        )}
      >
        <div onKeyDown={onListKey}>
          {/* Search input */}
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <Search className="size-4 shrink-0 text-fg-muted" aria-hidden />
            <input
              ref={inputRef}
              data-cmdk="true"
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIdx(0);
              }}
              placeholder={labels.placeholder}
              className="flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
              autoComplete="off"
              spellCheck={false}
            />
            <kbd className="hidden rounded border border-border bg-bg-muted px-1.5 py-0.5 font-mono text-xs text-fg-muted sm:inline-block">
              ESC
            </kbd>
          </div>

          {/* Results */}
          <div className="max-h-[60vh] overflow-y-auto p-2">
            {flatList.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-fg-muted">
                {labels.noResults}
              </p>
            ) : (
              <>
                {(['navigate', 'create', 'settings', 'docs'] as const).map((group) => {
                  const items = grouped[group];
                  if (items.length === 0) return null;
                  const groupLabel = {
                    navigate: labels.groupNavigate,
                    create:   labels.groupCreate,
                    settings: labels.groupSettings,
                    docs:     labels.groupDocs,
                  }[group];
                  return (
                    <div key={group} className="py-1">
                      <p className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                        {groupLabel}
                      </p>
                      <ul>
                        {items.map((cmd) => {
                          const Icon = ICONS[cmd.icon];
                          const flatIdx = flatList.indexOf(cmd);
                          const isActive = flatIdx === activeIdx;
                          return (
                            <li key={cmd.id}>
                              <button
                                type="button"
                                onMouseEnter={() => setActiveIdx(flatIdx)}
                                onClick={() => selectCommand(cmd, 'click')}
                                className={cn(
                                  'flex w-full items-center gap-3 rounded-md px-3 py-2',
                                  'text-left transition-colors duration-fast',
                                  isActive
                                    ? 'bg-primary-subtle text-fg'
                                    : 'text-fg hover:bg-bg-subtle',
                                )}
                              >
                                <Icon
                                  className={cn(
                                    'size-4 shrink-0',
                                    isActive ? 'text-primary' : 'text-fg-muted',
                                  )}
                                  aria-hidden
                                />
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-sm font-medium">{cmd.label}</p>
                                  {cmd.hint && (
                                    <p className="truncate text-xs text-fg-muted">{cmd.hint}</p>
                                  )}
                                </div>
                                {isActive && (
                                  <ArrowRight className="size-3.5 text-primary" aria-hidden />
                                )}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>
      </dialog>

      {/* Inline trigger — appears in the top-nav. Click opens palette,
          keyboard Cmd+K does the same thing. */}
      <button
        type="button"
        onClick={() => openPalette('click')}
        aria-label={labels.hintOpen}
        className={cn(
          'inline-flex items-center gap-2 rounded-md border border-border bg-bg-subtle',
          'px-2.5 py-1.5 text-sm text-fg-muted',
          'transition-colors duration-fast',
          'hover:border-border-strong hover:text-fg',
          'focus-visible:outline-none focus-visible:shadow-ring',
        )}
      >
        <Search className="size-3.5" aria-hidden />
        <span className="hidden sm:inline">{labels.placeholder}</span>
        <kbd className="hidden rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-xs text-fg-muted sm:inline-block">
          ⌘K
        </kbd>
      </button>
    </>
  );
}

