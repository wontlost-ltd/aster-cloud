'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Card, CardBody, Stack, buttonVariants, cn } from '@/components/ui';

/*
 * Admin feature flags card.
 *
 * Lives on the /admin overview page (above the Tools section).
 * Renders one row per known platform-settings key (policy_sharing.enabled
 * and the two structured-authoring capability switches) — add new flags by extending
 * FLAGS below + adding a key constant + i18n + a row.
 *
 * Optimistic toggle: flips the local state on click, hits POST
 * /api/admin/platform-settings, and rolls back on failure. The
 * helper layer's per-isolate cache means other Worker isolates
 * pick up the new value within ~60s — documented in
 * lib/platform-settings.ts.
 */

const FLAGS = [
  {
    key: 'policy_sharing.enabled',
    titleKey: 'policySharingTitle',
    descKey: 'policySharingDesc',
  },
  {
    key: 'capability.structured_authoring.enabled',
    titleKey: 'structuredAuthoringTitle',
    descKey: 'structuredAuthoringDesc',
  },
  {
    key: 'capability.structured_authoring.team_delegation.enabled',
    titleKey: 'structuredAuthoringDelegationTitle',
    descKey: 'structuredAuthoringDelegationDesc',
  },
] as const;

interface SettingsMap {
  [label: string]: { key: string; value: unknown };
}

export function FeatureFlagsCard() {
  const t = useTranslations('admin.flags');
  const [values, setValues] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/admin/platform-settings');
        if (!res.ok) return;
        const data = (await res.json()) as { settings: SettingsMap };
        const next: Record<string, boolean> = {};
        for (const entry of Object.values(data.settings)) {
          next[entry.key] = entry.value === true;
        }
        setValues(next);
      } catch {
        // Stay with defaults (OFF); admin can retry.
      }
    })();
  }, []);

  const toggle = async (key: string) => {
    const current = values[key] ?? false;
    const next = !current;
    setBusy((m) => ({ ...m, [key]: true }));
    setValues((m) => ({ ...m, [key]: next }));
    try {
      const res = await fetch('/api/admin/platform-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: next }),
      });
      if (!res.ok) {
        // Roll back optimistic update.
        setValues((m) => ({ ...m, [key]: current }));
      }
    } catch {
      setValues((m) => ({ ...m, [key]: current }));
    } finally {
      setBusy((m) => ({ ...m, [key]: false }));
    }
  };

  return (
    <Card>
      <CardBody className="pt-6">
        <Stack gap={4}>
          <h2 className="font-display text-xl font-semibold tracking-tight text-fg">
            {t('flagsHeading')}
          </h2>
          <ul className="flex flex-col gap-2">
            {FLAGS.map((flag) => {
              const enabled = values[flag.key] ?? false;
              const busyNow = busy[flag.key] ?? false;
              return (
                <li
                  key={flag.key}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-bg-subtle p-3"
                >
                  <Stack gap={1} className="min-w-0 flex-1">
                    <Stack direction="row" gap={2} align="center">
                      <p className="text-sm font-medium text-fg">
                        {t(flag.titleKey)}
                      </p>
                      <Badge variant={enabled ? 'success' : 'neutral'}>
                        {enabled ? t('on') : t('off')}
                      </Badge>
                    </Stack>
                    <p className="text-xs text-fg-muted">{t(flag.descKey)}</p>
                  </Stack>
                  <button
                    type="button"
                    onClick={() => toggle(flag.key)}
                    disabled={busyNow}
                    className={cn(
                      buttonVariants({
                        variant: enabled ? 'secondary' : 'primary',
                        size: 'sm',
                      }),
                      'disabled:opacity-50',
                    )}
                  >
                    {busyNow ? t('saving') : enabled ? t('disable') : t('enable')}
                  </button>
                </li>
              );
            })}
          </ul>
        </Stack>
      </CardBody>
    </Card>
  );
}
