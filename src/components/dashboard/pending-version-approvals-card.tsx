'use client';

import { useId } from 'react';
import { Badge, Card, CardBody, Stack, buttonVariants } from '@/components/ui';
import { Link } from '@/i18n/navigation';

/*
 * 仪表盘「等待你审批的策略版本」（#774）。
 *
 * 此前待审批版本只在 /approvals（且移动端表格把「Review」裁到视口外），从仪表盘看不到。这里只列出当前用户
 * 能审批的版本（服务端按 decideVersionApproval 算出的 canAct），每条直接给「Review」入口到版本页；
 * 批准 / 驳回仍在版本页完成，四眼原则与作者不能自审的规则不变——作者本人的提交不出现在这里。
 * 没有待办时整卡不渲染。
 */

/** 首屏最多列几条；更多的看徽标总数并经「全部审批」进入收件箱，避免待办多时把仪表盘其余内容挤到很下面 */
const MAX_ITEMS = 5;

export interface PendingVersionApprovalItem {
  versionId: string;
  policyId: string;
  policyName: string;
  version: number;
  submittedBy: string | null;
}

interface Labels {
  title: string;
  subtitle: string;
  review: string;
  /** 含 {name} 占位 */
  submittedBy: string;
  unknownUser: string;
  viewAll: string;
}

export function PendingVersionApprovalsCard({ items, labels }: { items: PendingVersionApprovalItem[]; labels: Labels }) {
  const titleId = useId();
  if (items.length === 0) return null;
  return (
    <Card role="region" aria-labelledby={titleId}>
      <CardBody className="pt-6">
        <Stack gap={4}>
          <Stack gap={1}>
            <Stack direction="row" gap={2} align="center">
              <h2 id={titleId} className="font-display text-xl font-semibold tracking-tight text-fg">
                {labels.title}
              </h2>
              <Badge variant="primary">{items.length}</Badge>
            </Stack>
            <p className="text-sm text-fg-muted">{labels.subtitle}</p>
          </Stack>
          <ul className="flex flex-col gap-2">
            {items.slice(0, MAX_ITEMS).map((item) => (
              <li
                key={item.versionId}
                data-version-id={item.versionId}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-bg-subtle p-3"
              >
                <Stack gap={1} className="min-w-0 flex-1">
                  <p className="break-words text-sm font-medium text-fg">
                    {item.policyName} · v{item.version}
                  </p>
                  <p className="text-xs text-fg-muted">
                    {labels.submittedBy.replace('{name}', item.submittedBy ?? labels.unknownUser)}
                  </p>
                </Stack>
                <Link
                  href={`/policies/${item.policyId}/versions`}
                  aria-label={`${labels.review}: ${item.policyName} v${item.version}`}
                  className={buttonVariants({ variant: 'primary', size: 'sm' })}
                >
                  {labels.review}
                </Link>
              </li>
            ))}
          </ul>
          <Link href="/approvals" className="self-start text-sm font-medium text-primary hover:text-primary-hover">
            {labels.viewAll} →
          </Link>
        </Stack>
      </CardBody>
    </Card>
  );
}
