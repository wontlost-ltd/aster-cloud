import 'server-only';

import type { GuardOrphansDetectedNotification } from '@/lib/notifications';
import { createLimiter } from '@/services/evidence/receipts-client';
import type { OrphanFeed, OrphanFeedTenantsPage } from './feed-client';
import { buildOrphanNotice, orphanNoticeId } from './payload';
import type { resolveOrphanRecipients } from './recipients';
import type { clearPending, commitTenantNotice, loadNotifyStates, markPending, NotifyState } from './state';

/**
 * 孤儿通知每 tick 编排（ADR 0065 §3.4.3）。
 * 全部 I/O 经 OrphanNotifyDeps 注入：单元测试用假实现，生产默认依赖在 guard-notifications.ts 组装。
 */

export const NOTIFY_LOOKBACK_MS = 7 * 24 * 3600_000;
/** 时钟偏差余量（R2）：多请求 5 分钟，由 aster-api 按自己的时钟收紧到 7 天，cloud 时钟快 / 慢都不漏边。 */
export const DETECTED_SINCE_SKEW_MS = 5 * 60_000;
export const QUIET_PERIOD_MS = 3600_000;
export const MAX_TENANTS_PER_TICK = 50;
export const SUMMARY_CONCURRENCY = 4;

export interface OrphanNotifyDeps {
  inAppEnabled(): Promise<boolean>;
  feed: OrphanFeed;
  loadStates: typeof loadNotifyStates;
  markPending: typeof markPending;
  clearPending: typeof clearPending;
  commit: typeof commitTenantNotice;
  recipients: typeof resolveOrphanRecipients;
  /** 第二阶段邮件挂点；抛错只记日志，不影响已提交的站内通知。 */
  afterCommit?(c: { tenantId: string; notice: GuardOrphansDetectedNotification; userIds: string[] }): Promise<void>;
}

/** 两个秒数字段均为向下取整的整秒；无对应租户时为 null。 */
export interface OrphanNotifyReport {
  ran: boolean;
  tenantsIndexed: number;
  pages: number;
  tenantsWithNew: number;
  noticesCreated: number;
  recipients: number;
  deferredQuiet: number;
  deferredBacklog: number;
  summaryFailed: number;
  casLost: number;
  noRecipients: number;
  emailed: number;
  /** 本 tick 已发通知中「最早检出时刻」到 now 的最大整秒数。 */
  maxLagSeconds: number | null;
  /** 被推迟（安静期 / 积压）或处理失败的租户，其 (pendingSince ?? now) 最小值到 now 的整秒数。 */
  oldestPendingSeconds: number | null;
}

interface IndexItem {
  tenantId: string;
  maxId: number;
}

interface Partitioned {
  work: IndexItem[];
  quiet: IndexItem[];
  backlog: IndexItem[];
}

const emptyReport = (): OrphanNotifyReport => ({
  ran: false,
  tenantsIndexed: 0,
  pages: 0,
  tenantsWithNew: 0,
  noticesCreated: 0,
  recipients: 0,
  deferredQuiet: 0,
  deferredBacklog: 0,
  summaryFailed: 0,
  casLost: 0,
  noRecipients: 0,
  emailed: 0,
  maxLagSeconds: null,
  oldestPendingSeconds: null,
});

const wholeSeconds = (from: number, to: number) => Math.floor((to - from) / 1000);

/** 步骤 2：翻完所有页；任一页抛错则整个 tick 抛出，此时尚未写任何状态。 */
async function indexTenants(feed: OrphanFeed, detectedSince: string, report: OrphanNotifyReport): Promise<IndexItem[]> {
  const items: IndexItem[] = [];
  let next: string | undefined;
  do {
    const page: OrphanFeedTenantsPage = await feed.tenants(
      next === undefined ? { detectedSince } : { detectedSince, afterTenant: next },
    );
    report.pages++;
    items.push(...page.items);
    next = page.next;
  } while (next !== undefined);
  report.tenantsIndexed = items.length;
  return items;
}

/** 步骤 4：安静期内的进 quiet；其余按 (pendingSince ?? now)、tenantId 升序（先进先出）取前 50 进 work。 */
function partition(candidates: IndexItem[], states: Map<string, NotifyState>, now: Date): Partitioned {
  const quiet: IndexItem[] = [];
  const ready: IndexItem[] = [];
  for (const c of candidates) {
    const last = states.get(c.tenantId)?.lastNoticeAt;
    (last && now.getTime() - last.getTime() < QUIET_PERIOD_MS ? quiet : ready).push(c);
  }
  const since = (c: IndexItem) => (states.get(c.tenantId)?.pendingSince ?? now).getTime();
  ready.sort((a, b) => since(a) - since(b) || (a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0));
  return { quiet, work: ready.slice(0, MAX_TENANTS_PER_TICK), backlog: ready.slice(MAX_TENANTS_PER_TICK) };
}

/** 单租户处理（步骤 5）：内部失败只计数，不向外抛。 */
async function processTenant(
  deps: OrphanNotifyDeps,
  item: IndexItem,
  afterId: number,
  detectedSince: string,
  now: Date,
  report: OrphanNotifyReport,
  failed: string[],
): Promise<void> {
  const { tenantId } = item;
  try {
    const s = await deps.feed.summary({ tenantId, afterId, detectedSince });
    if (s.total === 0) {
      await deps.clearPending(tenantId);
      return;
    }
    const r = await deps.recipients(tenantId);
    if (r.kind === 'unknown') console.warn('[guard-orphan-notify] unknown tenant', { tenantId });
    const userIds = r.kind === 'unknown' ? [] : r.userIds;
    if (userIds.length === 0) report.noRecipients++;
    const notice = buildOrphanNotice(s, r.kind === 'team' ? r.tenantName : '');
    const notices = userIds.map((userId) => ({ id: orphanNoticeId(tenantId, s.maxId, userId), userId, data: notice }));
    const res = await deps.commit({ tenantId, expectedThroughId: afterId, newThroughId: s.maxId, notices, now });
    if (res === 'cas_lost') {
      report.casLost++;
      return;
    }
    if (notices.length === 0) return;
    report.noticesCreated++;
    report.recipients += notices.length;
    const lag = wholeSeconds(Date.parse(notice.firstDetectedAt), now.getTime());
    report.maxLagSeconds = Math.max(report.maxLagSeconds ?? lag, lag);
    await runAfterCommit(deps, { tenantId, notice, userIds });
  } catch (err) {
    report.summaryFailed++;
    failed.push(tenantId);
    console.error('[guard-orphan-notify] tenant failed', { tenantId, err });
  }
}

async function runAfterCommit(
  deps: OrphanNotifyDeps,
  c: { tenantId: string; notice: GuardOrphansDetectedNotification; userIds: string[] },
): Promise<void> {
  if (!deps.afterCommit) return;
  try {
    await deps.afterCommit(c);
  } catch (err) {
    console.error('[guard-orphan-notify] afterCommit failed', { tenantId: c.tenantId, err });
  }
}

/** 被推迟的租户记 pendingSince 并回填 deferred 计数。 */
async function deferTenants(deps: OrphanNotifyDeps, { quiet, backlog }: Partitioned, now: Date, report: OrphanNotifyReport) {
  report.deferredQuiet = quiet.length;
  report.deferredBacklog = backlog.length;
  const ids = [...quiet, ...backlog].map((d) => d.tenantId);
  if (ids.length > 0) await deps.markPending(ids, now);
}

/**
 * 处理失败的租户同样记 pendingSince（cas_lost 不记：已被别的 tick 推进）。
 * 此处出错只记日志，不让整个 tick 失败：其他租户已处理完成。
 */
async function markFailed(deps: OrphanNotifyDeps, failed: string[], now: Date): Promise<void> {
  if (failed.length === 0) return;
  try {
    await deps.markPending(failed, now);
  } catch (err) {
    console.error('[guard-orphan-notify] markPending for failed tenants failed', { err });
  }
}

function oldestPendingSeconds(ids: string[], states: Map<string, NotifyState>, now: Date): number | null {
  if (ids.length === 0) return null;
  const oldest = ids.reduce((min, id) => Math.min(min, (states.get(id)?.pendingSince ?? now).getTime()), now.getTime());
  return wholeSeconds(oldest, now.getTime());
}

export async function runOrphanNotifyTick(deps: OrphanNotifyDeps, now: Date): Promise<OrphanNotifyReport> {
  if (!(await deps.inAppEnabled())) return emptyReport();
  const report: OrphanNotifyReport = { ...emptyReport(), ran: true };
  const detectedSince = new Date(now.getTime() - NOTIFY_LOOKBACK_MS - DETECTED_SINCE_SKEW_MS).toISOString();

  const items = await indexTenants(deps.feed, detectedSince, report);
  const states = await deps.loadStates(items.map((i) => i.tenantId));
  const candidates = items.filter((i) => i.maxId > (states.get(i.tenantId)?.notifiedThroughId ?? 0));
  report.tenantsWithNew = candidates.length;

  const parts = partition(candidates, states, now);
  await deferTenants(deps, parts, now, report);

  const limit = createLimiter(SUMMARY_CONCURRENCY);
  const failed: string[] = [];
  await Promise.all(
    parts.work.map((item) =>
      limit(() =>
        processTenant(deps, item, states.get(item.tenantId)?.notifiedThroughId ?? 0, detectedSince, now, report, failed),
      ),
    ),
  );
  await markFailed(deps, failed, now);
  const pending = [...parts.quiet, ...parts.backlog].map((d) => d.tenantId).concat(failed);
  report.oldestPendingSeconds = oldestPendingSeconds(pending, states, now);
  return report;
}
