'use client';

// 治理视图（#739）：按控制注册表展开 框架 → 控制项（条款）→ 策略，并列出未登记键与未关联策略。
// 只陈述源码里的 @control 引用与活动计数，不做合规判定。
import { useTranslations } from 'next-intl';
import { Badge, Breadcrumbs, Card, CardBody, CardHeader, CardTitle, Container, EmptyState, PageHeader, Stack } from '@/components/ui';
import { Link } from '@/i18n/navigation';
import { localizedTitle } from '@/services/evidence/control-registry';
import type { ControlGroup, GovernanceOverview, ImpactPolicy, ImpactVersion, PolicyActivity } from '@/lib/governance-impact';

interface Props {
  locale: string;
  overview: GovernanceOverview;
}

type Translate = ReturnType<typeof useTranslations<'governancePage'>>;

function versionLabel(v: ImpactVersion, t: Translate): string {
  const status = t(`versionStatus.${v.status}`);
  return v.isDefault ? `v${v.version} · ${status} · ${t('defaultVersion')}` : `v${v.version} · ${status}`;
}

function PolicyName({ policy }: { policy: PolicyActivity }) {
  return (
    <Link href={`/policies/${policy.id}`} className="font-medium text-primary hover:underline">
      {policy.name}
    </Link>
  );
}

function ActivityCells({ policy, t }: { policy: PolicyActivity; t: Translate }) {
  return (
    <>
      <td className="px-2 py-1">{policy.teamName ?? t('personal')}</td>
      <td className="px-2 py-1 text-right">{policy.executions30d}</td>
      <td className="px-2 py-1 text-right">
        {policy.pendingApprovals > 0
          ? <Badge variant="warning">{policy.pendingApprovals}</Badge>
          : policy.pendingApprovals}
      </td>
    </>
  );
}

function ImpactTable({ policies, t }: { policies: ImpactPolicy[]; t: Translate }) {
  if (policies.length === 0) return <p className="px-2 py-2 text-sm text-muted-foreground">{t('noPolicies')}</p>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr>
          <th className="px-2 py-1 text-left">{t('columns.policy')}</th>
          <th className="px-2 py-1 text-left">{t('columns.team')}</th>
          <th className="px-2 py-1 text-left">{t('columns.active')}</th>
          <th className="px-2 py-1 text-left">{t('columns.versions')}</th>
          <th className="px-2 py-1 text-right">{t('columns.executions30d')}</th>
          <th className="px-2 py-1 text-right">{t('columns.pendingApprovals')}</th>
        </tr>
      </thead>
      <tbody>
        {policies.map((p) => (
          <tr key={p.id} className="border-b border-border" data-testid={`impact-row-${p.id}`}>
            <td className="px-2 py-1"><PolicyName policy={p} /></td>
            <td className="px-2 py-1">{p.teamName ?? t('personal')}</td>
            <td className="px-2 py-1">
              <Badge variant={p.active ? 'success' : 'neutral'}>{p.active ? t('active') : t('inactive')}</Badge>
            </td>
            <td className="px-2 py-1">
              <ul className="list-none space-y-0.5">
                {p.versions.map((v) => <li key={v.version}>{versionLabel(v, t)}</li>)}
              </ul>
            </td>
            <td className="px-2 py-1 text-right">{p.executions30d}</td>
            <td className="px-2 py-1 text-right">
              {p.pendingApprovals > 0 ? <Badge variant="warning">{p.pendingApprovals}</Badge> : p.pendingApprovals}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ControlSection({ control, locale, t }: { control: ControlGroup; locale: string; t: Translate }) {
  return (
    <details className="rounded-md border border-border" data-testid={`control-${control.key}`}>
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2">
        <span className="font-medium">{t('article', { article: control.article })}</span>
        <span>{localizedTitle(control.title, locale)}</span>
        <code className="text-xs text-muted-foreground">{control.key}</code>
        <Badge variant={control.policies.length > 0 ? 'primary' : 'neutral'}>
          {t('policyCount', { count: control.policies.length })}
        </Badge>
      </summary>
      <div className="px-2 pb-2">
        <ImpactTable policies={control.policies} t={t} />
      </div>
    </details>
  );
}

export function GovernanceContent({ locale, overview }: Props) {
  const t = useTranslations('governancePage');

  return (
    <Container size="xl" className="py-6 sm:py-10">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        breadcrumbs={<Breadcrumbs items={[{ label: t('breadcrumb') }]} />}
        className="mb-6"
      />

      <Stack gap={6}>
        <p className="text-sm text-muted-foreground" data-testid="registry-version">
          {t('registryVersion', { version: overview.registryVersion })}
        </p>

        {overview.frameworks.map((framework) => (
          <Card key={framework.id} data-testid={`framework-${framework.id}`}>
            <CardHeader>
              <CardTitle>{localizedTitle(framework.title, locale)}</CardTitle>
            </CardHeader>
            <CardBody>
              <Stack gap={2}>
                {framework.controls.map((control) => (
                  <ControlSection key={control.key} control={control} locale={locale} t={t} />
                ))}
              </Stack>
            </CardBody>
          </Card>
        ))}

        {overview.unregistered.length > 0 && (
          <Card data-testid="unregistered">
            <CardHeader>
              <CardTitle>{t('unregistered.title')}</CardTitle>
            </CardHeader>
            <CardBody>
              <p className="mb-2 text-sm text-muted-foreground">{t('unregistered.hint')}</p>
              <Stack gap={2}>
                {overview.unregistered.map((group) => (
                  <details key={group.key} className="rounded-md border border-border" data-testid={`control-${group.key}`}>
                    <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2">
                      <code className="text-xs">{group.key}</code>
                      <Badge variant="warning">{t('policyCount', { count: group.policies.length })}</Badge>
                    </summary>
                    <div className="px-2 pb-2">
                      <ImpactTable policies={group.policies} t={t} />
                    </div>
                  </details>
                ))}
              </Stack>
            </CardBody>
          </Card>
        )}

        <Card data-testid="unlinked">
          <CardHeader>
            <CardTitle>{t('unlinked.title')}</CardTitle>
          </CardHeader>
          <CardBody>
            {overview.unlinked.length === 0 ? (
              <EmptyState title={t('unlinked.empty')} />
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="px-2 py-1 text-left">{t('columns.policy')}</th>
                    <th className="px-2 py-1 text-left">{t('columns.team')}</th>
                    <th className="px-2 py-1 text-right">{t('columns.executions30d')}</th>
                    <th className="px-2 py-1 text-right">{t('columns.pendingApprovals')}</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.unlinked.map((p) => (
                    <tr key={p.id} className="border-b border-border" data-testid={`unlinked-row-${p.id}`}>
                      <td className="px-2 py-1"><PolicyName policy={p} /></td>
                      <ActivityCells policy={p} t={t} />
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardBody>
        </Card>
      </Stack>
    </Container>
  );
}
