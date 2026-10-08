'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Bell } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { cn } from '@/components/ui';

/*
 * Topbar bell — unread-count badge + drop-down list.
 *
 * Polls /api/notifications/count every 30s for the badge and
 * /api/notifications once when the drop-down opens (lazy load).
 * On open, posts /api/notifications/mark-read (no body) to clear the
 * unread badge without forcing the user to dismiss every item.
 *
 * 30s is the cheapest "felt real-time" cadence for this surface:
 * users notice "I have a notification" within half a minute. The
 * count endpoint is a single bounded aggregate (≤50 rows) so the
 * Hyperdrive cost is negligible. SSE is the proper real-time option
 * but it requires a Durable Object on Workers — a separate piece of
 * infrastructure we don't need yet for this notification volume.
 *
 * Bell is intentionally a thin client component that talks to REST.
 * The list rendering is templated per `kind` — adding a new
 * notification source means extending NotificationItem's switch.
 */

const POLL_INTERVAL_MS = 30_000;

interface NotificationRow {
  id: string;
  kind: string;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

type Labels = ReturnType<typeof useLabels>;

function useLabels() {
  const t = useTranslations('notifications');
  return {
    label: t('label'),
    empty: t('empty'),
    viewAll: t('viewAll'),
    invitationReceived: t.raw('invitationReceived') as string,
    invitationAccepted: t.raw('invitationAccepted') as string,
    policyShared: t.raw('policyShared') as string,
    guardApprovalRequested: t.raw('guardApprovalRequested') as string,
    guardApprovalDecided: t.raw('guardApprovalDecided') as string,
    guardOutcomeApproved: t('guardOutcomeApproved'),
    guardOutcomeRejected: t('guardOutcomeRejected'),
    permissionView: t('permissionView'),
    permissionExecute: t('permissionExecute'),
    timeAgoNow: t('timeAgoNow'),
    timeAgoMin: t.raw('timeAgoMin') as string,
    timeAgoHour: t.raw('timeAgoHour') as string,
    timeAgoDay: t.raw('timeAgoDay') as string,
  };
}

/**
 * 模板占位符替换：用函数作替换值，策略名/团队名等用户数据里的 `$&`、`$'` 等不会被当作替换模式解释。
 */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce((out, [key, value]) => out.replace(`{${key}}`, () => value), template);
}

function formatRelative(iso: string, labels: Labels): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return labels.timeAgoNow;
  if (min < 60) return fillTemplate(labels.timeAgoMin, { n: String(min) });
  const hour = Math.floor(min / 60);
  if (hour < 24) return fillTemplate(labels.timeAgoHour, { n: String(hour) });
  const day = Math.floor(hour / 24);
  return fillTemplate(labels.timeAgoDay, { n: String(day) });
}

export function renderText(
  row: NotificationRow,
  labels: Labels,
): { text: string; href?: string } {
  // Each branch substitutes the kind-specific {placeholders} into
  // its i18n template. Adding a new kind: extend the switch and
  // the messages/*.json `notifications` namespace.
  switch (row.kind) {
    case 'team.invitation_received': {
      const d = row.data as { teamName?: string; role?: string };
      return {
        text: fillTemplate(labels.invitationReceived, { teamName: d.teamName ?? 'a team', role: d.role ?? 'member' }),
        href: '/teams',
      };
    }
    case 'team.invitation_accepted': {
      const d = row.data as { teamName?: string; memberName?: string };
      return {
        text: fillTemplate(labels.invitationAccepted, {
          memberName: d.memberName ?? 'A teammate',
          teamName: d.teamName ?? 'a team',
        }),
        href: `/teams/${(row.data as { teamId?: string }).teamId ?? ''}`,
      };
    }
    case 'policy.shared': {
      const d = row.data as {
        policyName?: string;
        teamName?: string;
        policyId?: string;
        permission?: 'view' | 'execute';
      };
      const tier =
        d.permission === 'view'
          ? labels.permissionView
          : labels.permissionExecute;
      return {
        text: fillTemplate(labels.policyShared, {
          policyName: d.policyName ?? 'a policy',
          teamName: d.teamName ?? 'your team',
          permission: tier,
        }),
        href: d.policyId ? `/policies/${d.policyId}` : '/policies',
      };
    }
    case 'guard.approval_requested': {
      const d = row.data as { policyName?: string; decisionId?: string };
      return {
        text: fillTemplate(labels.guardApprovalRequested, { policyName: d.policyName ?? 'a policy' }),
        href: d.decisionId ? `/approvals?decisionId=${encodeURIComponent(d.decisionId)}` : '/approvals',
      };
    }
    case 'guard.approval_decided': {
      const d = row.data as { policyName?: string; policyId?: string; outcome?: 'APPROVED' | 'REJECTED' };
      const outcome = d.outcome === 'REJECTED' ? labels.guardOutcomeRejected : labels.guardOutcomeApproved;
      return {
        text: fillTemplate(labels.guardApprovalDecided, { policyName: d.policyName ?? 'a policy', outcome }),
        href: d.policyId ? `/policies/${d.policyId}/logs` : '/approvals',
      };
    }
    default:
      return { text: row.kind };
  }
}

export function NotificationsBell() {
  const labels = useLabels();
  const [unread, setUnread] = useState<number>(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationRow[] | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Cheap polling for the badge count. We do NOT poll the full list
  // — that's lazy-loaded when the drop-down opens.
  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch('/api/notifications/count');
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as { count: number };
        setUnread(data.count);
      } catch {
        // Network / fetch errors are transient — keep last good count.
      }
    }
    tick();
    const id = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  // Close on ESC.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const handleOpen = useCallback(async () => {
    setOpen(true);
    // Lazy-load the list once. Subsequent re-opens reuse the cached
    // state until the user navigates away (component unmount).
    if (items === null) {
      try {
        const res = await fetch('/api/notifications?limit=10');
        if (res.ok) {
          const data = (await res.json()) as { notifications: NotificationRow[] };
          setItems(data.notifications);
        } else {
          setItems([]);
        }
      } catch {
        setItems([]);
      }
    }
    // Mark-all-read: drops the badge without forcing the user to
    // explicitly dismiss every row. Failures are non-fatal — the
    // next poll cycle will re-fetch the count and self-correct.
    if (unread > 0) {
      try {
        await fetch('/api/notifications/mark-read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        setUnread(0);
        setItems((prev) =>
          prev
            ? prev.map((r) => (r.readAt ? r : { ...r, readAt: new Date().toISOString() }))
            : prev,
        );
      } catch {
        // ignore
      }
    }
  }, [items, unread]);

  const displayCount = unread > 50 ? '50+' : String(unread);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : handleOpen())}
        aria-label={labels.label}
        aria-haspopup="true"
        aria-expanded={open}
        className="relative inline-flex size-9 items-center justify-center rounded-md text-fg-muted hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:shadow-ring"
      >
        <Bell className="size-5" aria-hidden />
        {unread > 0 && (
          <span
            aria-hidden
            className={cn(
              'absolute -top-0.5 -right-0.5 inline-flex min-w-[1.125rem] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-none text-danger-fg',
              'h-[1.125rem]',
            )}
          >
            {displayCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={labels.label}
          className="absolute right-0 top-full z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-bg shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-border bg-bg-subtle px-3 py-2">
            <p className="text-sm font-semibold text-fg">{labels.label}</p>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items === null ? (
              <p className="px-3 py-6 text-center text-sm text-fg-muted">…</p>
            ) : items.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-fg-muted">
                {labels.empty}
              </p>
            ) : (
              <ul role="list" className="divide-y divide-border">
                {items.map((row) => {
                  const { text, href } = renderText(row, labels);
                  const isUnread = row.readAt === null;
                  const inner = (
                    <div
                      className={cn(
                        'flex flex-col gap-1 px-3 py-2 text-sm',
                        isUnread && 'bg-primary-subtle/30',
                      )}
                    >
                      <p className="text-fg">{text}</p>
                      <p className="text-xs text-fg-subtle">
                        {formatRelative(row.createdAt, labels)}
                      </p>
                    </div>
                  );
                  return (
                    <li key={row.id}>
                      {href ? (
                        <Link
                          href={href}
                          onClick={() => setOpen(false)}
                          className="block hover:bg-bg-subtle focus-visible:bg-bg-subtle focus-visible:outline-none"
                        >
                          {inner}
                        </Link>
                      ) : (
                        inner
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="border-t border-border px-3 py-2 text-right">
            <Link
              href="/teams"
              onClick={() => setOpen(false)}
              className="text-xs font-medium text-primary hover:underline focus-visible:underline focus-visible:outline-none"
            >
              {labels.viewAll} →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
