'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
  Badge,
  Card,
  CardBody,
  Stack,
  buttonVariants,
  cn,
} from '@/components/ui';
import { formatDate } from '@/lib/format';

/*
 * Pending team invitations — in-app inbox card.
 *
 * Mounted on /teams (and re-mountable elsewhere later). Polls a
 * per-user inbox endpoint that returns every pending invitation
 * addressed to the signed-in account's email. Lets the user accept
 * or decline without leaving the app — no email click required.
 *
 * Hides itself when the inbox is empty, so a user with no pending
 * invitations doesn't see a permanent "Pending invitations (0)"
 * label cluttering the page. On accept the page is refreshed via
 * router.refresh() so the new team appears in the teams list
 * server-rendered above.
 */

interface InboxItem {
  id: string;
  teamId: string;
  teamName: string;
  teamSlug: string;
  role: string;
  expiresAt: string;
  createdAt: string;
}

type ItemState = 'idle' | 'accepting' | 'declining' | 'error';

interface Labels {
  title: string;
  subtitle: string;
  expiresOn: string;
  accept: string;
  decline: string;
  accepting: string;
  declining: string;
  acceptFailed: string;
  declineFailed: string;
  rolePrefix: string;
}

export function PendingInvitationsCard() {
  const t = useTranslations('teams.inbox');
  const locale = useLocale();
  const router = useRouter();
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [pending, setPending] = useState<Record<string, ItemState>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  const labels: Labels = {
    title: t('title'),
    subtitle: t('subtitle'),
    expiresOn: t.raw('expiresOn') as string,
    accept: t('accept'),
    decline: t('decline'),
    accepting: t('accepting'),
    declining: t('declining'),
    acceptFailed: t('acceptFailed'),
    declineFailed: t('declineFailed'),
    rolePrefix: t.raw('rolePrefix') as string,
  };

  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/teams/invitations/inbox');
      if (!res.ok) {
        setItems([]);
        return;
      }
      const data = (await res.json()) as { invitations: InboxItem[] };
      setItems(data.invitations);
    } catch {
      setItems([]);
    }
  }, []);

  useEffect(() => {
    // 挂载时异步拉取收件箱并起 30 秒轮询；setState 均在 await 之后触发，
    // 属正常数据加载副作用，非渲染期同步 setState。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload();
    // Same 30s cadence as the topbar bell so an invite that lands
    // while the user is sitting on /teams surfaces without a manual
    // refresh. Cheap query (single email-matched select), bounded by
    // the user's actual pending count.
    const id = window.setInterval(reload, 30_000);
    return () => window.clearInterval(id);
  }, [reload]);

  const onAccept = useCallback(
    async (item: InboxItem) => {
      setPending((m) => ({ ...m, [item.id]: 'accepting' }));
      setErrors((m) => ({ ...m, [item.id]: null }));
      try {
        const res = await fetch('/api/teams/invitations/accept', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ invitationId: item.id }),
        });
        if (!res.ok) {
          setErrors((m) => ({ ...m, [item.id]: labels.acceptFailed }));
          setPending((m) => ({ ...m, [item.id]: 'error' }));
          return;
        }
        // Remove from inbox + refresh server-rendered teams list.
        setItems((prev) => prev?.filter((i) => i.id !== item.id) ?? []);
        router.refresh();
      } catch {
        setErrors((m) => ({ ...m, [item.id]: labels.acceptFailed }));
        setPending((m) => ({ ...m, [item.id]: 'error' }));
      }
    },
    [labels.acceptFailed, router],
  );

  const onDecline = useCallback(
    async (item: InboxItem) => {
      setPending((m) => ({ ...m, [item.id]: 'declining' }));
      setErrors((m) => ({ ...m, [item.id]: null }));
      try {
        const res = await fetch('/api/teams/invitations/decline', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ invitationId: item.id }),
        });
        if (!res.ok) {
          setErrors((m) => ({ ...m, [item.id]: labels.declineFailed }));
          setPending((m) => ({ ...m, [item.id]: 'error' }));
          return;
        }
        setItems((prev) => prev?.filter((i) => i.id !== item.id) ?? []);
      } catch {
        setErrors((m) => ({ ...m, [item.id]: labels.declineFailed }));
        setPending((m) => ({ ...m, [item.id]: 'error' }));
      }
    },
    [labels.declineFailed],
  );

  // Loading / empty: render nothing — the card is opt-in surface.
  if (items === null || items.length === 0) return null;

  return (
    <Card>
      <CardBody className="pt-6">
        <Stack gap={4}>
          <Stack gap={1}>
            <Stack direction="row" gap={2} align="center">
              <h2 className="font-display text-xl font-semibold tracking-tight text-fg">
                {labels.title}
              </h2>
              <Badge variant="primary">{items.length}</Badge>
            </Stack>
            <p className="text-sm text-fg-muted">{labels.subtitle}</p>
          </Stack>

          <ul className="flex flex-col gap-2">
            {items.map((item) => {
              const state = pending[item.id] ?? 'idle';
              const isBusy = state === 'accepting' || state === 'declining';
              const expiresDate = formatDate(item.expiresAt, locale);
              return (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-bg-subtle p-3"
                >
                  <Stack gap={1} className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-fg">
                      {item.teamName}
                    </p>
                    <p className="text-xs text-fg-muted">
                      {labels.rolePrefix.replace('{role}', item.role)} ·{' '}
                      {labels.expiresOn.replace('{date}', expiresDate)}
                    </p>
                    {errors[item.id] && (
                      <p className="text-xs text-danger">{errors[item.id]}</p>
                    )}
                  </Stack>
                  <Stack direction="row" gap={2} className="shrink-0">
                    <button
                      type="button"
                      onClick={() => onDecline(item)}
                      disabled={isBusy}
                      className={cn(
                        buttonVariants({ variant: 'secondary', size: 'sm' }),
                        'disabled:opacity-50',
                      )}
                    >
                      {state === 'declining' ? labels.declining : labels.decline}
                    </button>
                    <button
                      type="button"
                      onClick={() => onAccept(item)}
                      disabled={isBusy}
                      className={cn(
                        buttonVariants({ variant: 'primary', size: 'sm' }),
                        'disabled:opacity-50',
                      )}
                    >
                      {state === 'accepting' ? labels.accepting : labels.accept}
                    </button>
                  </Stack>
                </li>
              );
            })}
          </ul>
        </Stack>
      </CardBody>
    </Card>
  );
}
