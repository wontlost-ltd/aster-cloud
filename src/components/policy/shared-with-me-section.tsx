'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Badge, Card, CardBody, Stack } from '@/components/ui';
import { formatDate } from '@/lib/format';

/*
 * "Shared with my teams" section on /policies.
 *
 * Mounted only when the server-side policy_sharing.enabled gate is on
 * (see policies/page.tsx), so the mount-time GET /api/policies/shared-with-me
 * is not fired on the common "sharing off" path. A 404 (flag flipped off
 * between render and fetch) or an empty list renders nothing — we don't
 * want a permanent empty box on the policies page.
 *
 * Read-only: clicking a row opens /policies/:id. Revoke lives on the
 * owning team's policy detail (the policy owner controls who can
 * see/run it). Execute permission is filtered server-side; the badge
 * here is informational.
 */

type SharePermission = 'view' | 'execute';

interface SharedPolicy {
  shareId: string;
  policyId: string;
  policyName: string;
  policyDescription: string | null;
  teamId: string;
  teamName: string;
  ownerName: string | null;
  permission: SharePermission;
  updatedAt: string;
}

interface Props {
  locale: string;
}

export function SharedWithMeSection({ locale }: Props) {
  const t = useTranslations('policies.sharedWithMe');
  const [items, setItems] = useState<SharedPolicy[] | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    void (async () => {
      try {
        const res = await fetch('/api/policies/shared-with-me', {
          signal: ctrl.signal,
        });
        if (ctrl.signal.aborted) return;
        if (res.status === 404 || !res.ok) {
          // 404 = feature off or no team memberships. Other non-2xx
          // = transient; render nothing rather than a broken section.
          setEnabled(false);
          return;
        }
        const data = (await res.json()) as { shares: SharedPolicy[] };
        if (ctrl.signal.aborted) return;
        setEnabled(true);
        setItems(data.shares);
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') return;
        setEnabled(false);
      }
    })();
    return () => ctrl.abort();
  }, []);

  if (enabled !== true || items === null || items.length === 0) return null;

  return (
    <Card className="mt-6">
      <CardBody className="pt-6">
        <Stack gap={4}>
          <Stack gap={1}>
            <h2 className="font-display text-xl font-semibold tracking-tight text-fg">
              {t('title')}
            </h2>
            <p className="text-sm text-fg-muted">{t('subtitle')}</p>
          </Stack>
          <ul className="flex flex-col gap-2">
            {items.map((s) => (
              <li
                key={s.shareId}
                className="rounded-md border border-border bg-bg-subtle p-3 transition-colors hover:bg-bg-muted"
              >
                <Link
                  href={`/policies/${s.policyId}`}
                  className="block focus-visible:outline-none"
                >
                  <Stack gap={2}>
                    <div className="flex items-center justify-between gap-3">
                      <p className="truncate text-sm font-medium text-primary hover:underline">
                        {s.policyName}
                      </p>
                      <Badge
                        variant={s.permission === 'execute' ? 'success' : 'neutral'}
                      >
                        {s.permission === 'execute'
                          ? t('permissionExecute')
                          : t('permissionView')}
                      </Badge>
                    </div>
                    {s.policyDescription && (
                      <p className="truncate text-sm text-fg-muted">
                        {s.policyDescription}
                      </p>
                    )}
                    <p className="text-xs text-fg-subtle">
                      {t('viaTeam', { team: s.teamName })}
                      {s.ownerName && (
                        <> · {t('fromOwner', { owner: s.ownerName })}</>
                      )}
                      {' · '}
                      {t('updated', {
                        date: formatDate(s.updatedAt, locale),
                      })}
                    </p>
                  </Stack>
                </Link>
              </li>
            ))}
          </ul>
        </Stack>
      </CardBody>
    </Card>
  );
}
