'use client';

import { createBooleanPreference, ONE_ZERO, useBooleanPreference } from '@/lib/preferences/boolean-preference';
import { Plus, Check, Sparkles, KeyRound, Users, CreditCard } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { CLIENT_CAPABILITIES } from '@/hooks/use-deployment-mode';
import {
  Badge,
  Card,
  CardBody,
  Stack,
  buttonVariants,
  cn,
} from '@/components/ui';

/*
 * Admin launchpad — first-viewport setup checklist for SaaS admins
 * on a fresh tenant. Replaces the zero-stat first impression with a
 * five-step "ready in 60 seconds" runway.
 *
 * Visibility rules (decided by the caller, not this component):
 *   - Render only when session.user.isAdmin is true.
 *   - Hide when all five signals are satisfied (checklist done).
 *   - Local-storage "dismissed" flag persists across reloads so a
 *     paid admin who already set everything up doesn't see it
 *     resurrected after a transient signal flip.
 *
 * Each step row stays interactive after completion — the CTA links
 * remain useful (e.g. "Manage API keys" after the first key is
 * issued) so the launchpad doubles as quick navigation to the
 * relevant org-config pages.
 */

export interface SetupSignals {
  hasPolicy: boolean;
  hasApiKey: boolean;
  hasAiKey: boolean;
  hasTeammate: boolean;
  hasReviewedBilling: boolean;
}

export interface LaunchpadTranslations {
  title: string;
  body: string;
  progressTemplate: string;
  dismiss: string;
  steps: {
    createPolicy: { label: string; desc: string; cta: string };
    addApiKey: { label: string; desc: string; cta: string };
    addAiKey: { label: string; desc: string; cta: string };
    inviteTeam: { label: string; desc: string; cta: string };
    reviewBilling: { label: string; desc: string; cta: string };
  };
}

interface AdminLaunchpadProps {
  signals: SetupSignals;
  translations: LaunchpadTranslations;
}

const DISMISS_KEY = 'aster.admin.launchpad.dismissed';
// 已上线的键存的是 '1'，沿用该编码
const dismissedPreference = createBooleanPreference(DISMISS_KEY, false, ONE_ZERO);


export function AdminLaunchpad({ signals, translations: t }: AdminLaunchpadProps) {
  // 收起状态存在 localStorage，服务端读不到：水合期间按未收起渲染（与 SSR 一致），水合后才隐藏（#774 #418）。
  const { value: dismissed, setValue: setDismissed } = useBooleanPreference(dismissedPreference);

  if (dismissed) return null;

  // The billing step is SaaS-only — on-prem builds never have a /billing
  // route. Conditionally appending it (rather than always rendering with
  // a runtime hide) keeps the verify-on-prem-ui scanner happy: the on-
  // prem bundle never sees the string '/billing' in the launchpad's
  // emitted code path.
  const steps = [
    {
      id: 'createPolicy',
      done: signals.hasPolicy,
      icon: Plus,
      copy: t.steps.createPolicy,
      href: '/policies/new',
    },
    {
      id: 'addApiKey',
      done: signals.hasApiKey,
      icon: KeyRound,
      copy: t.steps.addApiKey,
      href: '/settings/api-keys',
    },
    {
      id: 'addAiKey',
      done: signals.hasAiKey,
      icon: Sparkles,
      copy: t.steps.addAiKey,
      href: '/settings/ai-keys',
    },
    {
      id: 'inviteTeam',
      done: signals.hasTeammate,
      icon: Users,
      copy: t.steps.inviteTeam,
      href: '/teams',
    },
    ...(CLIENT_CAPABILITIES.billing
      ? [
          {
            id: 'reviewBilling' as const,
            done: signals.hasReviewedBilling,
            icon: CreditCard,
            copy: t.steps.reviewBilling,
            href: '/billing',
          },
        ]
      : []),
  ] as const;

  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null; // all five satisfied → hide

  const progress = t.progressTemplate
    .replace('{done}', String(done))
    .replace('{total}', String(steps.length));

  return (
    <Card>
      <CardBody className="pt-6">
        <Stack gap={5}>
          <Stack
            direction="row"
            justify="between"
            align="start"
            gap={3}
            wrap
          >
            <Stack gap={1} className="min-w-0 flex-1">
              <Stack direction="row" gap={2} align="center">
                <h2 className="font-display text-xl font-semibold tracking-tight text-fg">
                  {t.title}
                </h2>
                <Badge variant="primary">{progress}</Badge>
              </Stack>
              <p className="text-sm text-fg-muted">{t.body}</p>
            </Stack>
            <button
              type="button"
              onClick={() => {
                setDismissed(true);
              }}
              className="text-xs text-fg-subtle hover:text-fg focus-visible:outline-none focus-visible:underline"
            >
              {t.dismiss}
            </button>
          </Stack>

          <ol className="flex flex-col gap-3">
            {steps.map((s) => {
              const Icon = s.icon;
              return (
                <li
                  key={s.id}
                  className={cn(
                    'flex items-start gap-3 rounded-md border border-border p-3',
                    s.done ? 'bg-success-subtle' : 'bg-bg',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full border',
                      s.done
                        ? 'border-success bg-success text-success-fg'
                        : 'border-border bg-bg-subtle text-fg-muted',
                    )}
                    aria-hidden
                  >
                    {s.done ? (
                      <Check className="size-4" />
                    ) : (
                      <Icon className="size-4" />
                    )}
                  </span>
                  <Stack gap={1} className="min-w-0 flex-1">
                    <p
                      className={cn(
                        'text-sm font-medium',
                        s.done ? 'text-success line-through' : 'text-fg',
                      )}
                    >
                      {s.copy.label}
                    </p>
                    <p className="text-sm text-fg-muted">{s.copy.desc}</p>
                  </Stack>
                  <Link
                    href={s.href}
                    className={cn(
                      buttonVariants({
                        variant: s.done ? 'secondary' : 'primary',
                        size: 'sm',
                      }),
                      'shrink-0',
                    )}
                  >
                    {s.copy.cta}
                  </Link>
                </li>
              );
            })}
          </ol>
        </Stack>
      </CardBody>
    </Card>
  );
}
