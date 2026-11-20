/**
 * 按请求的 severity 凑一页孤儿（ADR 0061 §3.4「新旧兼容」，计划 T3 `fillFilteredPage`）。
 *
 * 旧 aster-api 静默忽略 `severity`，会返回全部 severity；BFF 因此总是在交给 UI 前再过滤一次。只有当某个上游页里
 * 出现了未请求的 severity（= 上游是旧 api）、过滤后不足 `q.limit` 且上游仍有 `next` 时，才以 `before = next`
 * 续取下一原始页，至多共 MAX_UPSTREAM_PAGES 次上游调用。
 *
 * 游标：aster-api 的 `before` 是 `id <` 条件、按 id 降序。凑满时停在当前原始页内，返回的 `next` 取最后一条
 * **返回项**的 id（该页剩余行在下一次请求里重新出现，不漏行）；未凑满时 `next` 取最后一次上游调用的 `next`
 * （无则省略，UI 仍可据此「加载更多」）。新 api 下恰好 1 次调用、`next` 原样。
 */
import 'server-only';

import type { GuardOrphan, GuardOrphanPage, GuardOrphanQuery } from '@/services/policy/guard-types';
import type { ReconciliationApi } from './access';

export const MAX_UPSTREAM_PAGES = 5;

function page(items: GuardOrphan[], next: number | undefined): GuardOrphanPage {
  return next === undefined ? { items } : { items, next };
}

export async function fillFilteredPage(api: ReconciliationApi, q: GuardOrphanQuery): Promise<GuardOrphanPage> {
  const wanted = new Set<string>(q.severities);
  const items: GuardOrphan[] = [];
  let before = q.before;
  let legacy = false;
  for (let call = 1; ; call++) {
    const raw = await api.listOrphans({ ...q, before });
    for (let i = 0; i < raw.items.length; i++) {
      const o = raw.items[i];
      if (wanted.size > 0 && !wanted.has(o.severity)) {
        legacy = true;
        continue;
      }
      items.push(o);
      if (items.length === q.limit) {
        const more = i < raw.items.length - 1 || raw.next !== undefined;
        return page(items, more ? o.id : undefined);
      }
    }
    if (!legacy || raw.next === undefined || call >= MAX_UPSTREAM_PAGES) return page(items, raw.next);
    before = raw.next;
  }
}
