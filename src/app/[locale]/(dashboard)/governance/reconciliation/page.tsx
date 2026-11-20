import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Breadcrumbs } from '@/components/ui';
import { getSession } from '@/lib/auth';
import { listReconciliationTenants } from '@/lib/guard-reconciliation/access';
import { parseOrphanQuery } from '@/lib/guard-reconciliation/query';
import { DEFAULT_ORPHAN_FILTER, type OrphanFilter } from '@/lib/guard-reconciliation/ui';
import { localizedTitle } from '@/lib/page-metadata';
import { ReconciliationContent, type TenantOption } from './reconciliation-content';

export const generateMetadata = localizedTitle('guardReconciliation', 'title');

type SearchParams = Record<string, string | string[] | undefined>;

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<SearchParams>;
}

/** URL 上的过滤条件；非法或缺省 → 缺省过滤（OPEN + critical,warning），客户端随后把 URL 规范化。 */
function initialFilter(sp: SearchParams): OrphanFilter {
  const params = new URLSearchParams();
  for (const key of ['status', 'severity', 'kind'] as const) {
    const v = sp[key];
    if (typeof v === 'string') params.set(key, v);
  }
  const q = parseOrphanQuery(params);
  if (!q) return { status: DEFAULT_ORPHAN_FILTER.status, severities: [...DEFAULT_ORPHAN_FILTER.severities] };
  return { status: q.status, severities: q.severities, ...(q.kind ? { kind: q.kind } : {}) };
}

/**
 * /governance/reconciliation?tenant=&status=&severity=&kind=（ADR 0061 §3.7）：按租户的孤儿动作明细。
 *
 * 服务端只做会话校验与可见租户（个人租户 + 角色 ≥ member 的团队，现查），不调用 aster-api：列表与缺省租户
 * （R6：摘要里 critical 最多者）都在客户端取，SSR 不被对账请求阻塞。`?tenant=` 不在可见列表时按缺省处理。
 */
export default async function GuardReconciliationPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  const session = await getSession();
  if (!session?.user?.id) {
    redirect(`/${locale}/login`);
  }
  const sp = await searchParams;
  const [tenants, t, tGov] = await Promise.all([
    listReconciliationTenants(session.user.id),
    getTranslations('guardReconciliation'),
    getTranslations('governancePage'),
  ]);
  const options: TenantOption[] = tenants.map((x) => ({ id: x.id, name: x.name, canAck: x.access.canAck }));
  const requested = typeof sp.tenant === 'string' ? sp.tenant : undefined;
  const initialTenantId = options.some((o) => o.id === requested) ? requested! : null;

  return (
    <ReconciliationContent
      locale={locale}
      tenants={options}
      initialTenantId={initialTenantId}
      initialFilter={initialFilter(sp)}
      breadcrumbs={<Breadcrumbs items={[{ label: tGov('breadcrumb'), href: '/governance' }, { label: t('title') }]} />}
    />
  );
}
