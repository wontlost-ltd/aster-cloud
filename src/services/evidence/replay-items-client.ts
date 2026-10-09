/**
 * 向 aster-api 批量取 What-If 回放条目（ADR 0044 §3）。
 *
 * 与 receipts-client 同一套纪律：分批、有界并发、每批超时；非 2xx / 超时 / 网络错 / 响应畸形 ⇒
 * 该批 id 整体记入 unavailable，不重试、不伪造。未出现在响应里的 id 表示「无回放」，既不入 items 也不算 unavailable。
 */
import 'server-only';

import { signInternalCallerHeaders } from '@/lib/api-signing';
import { getApiConfig } from '@/services/policy/policy-api';
import { createLimiter, RECEIPT_BATCH, RECEIPT_TIMEOUT_MS, type Limiter } from './receipts-client';
import type { EvidenceWhatIf } from './types';

export type ReplayItemLookup = {
  items: Map<string, EvidenceWhatIf>;
  unavailable: Set<string>;
};

const PATH = '/api/v1/replay/items';
const CALLER_USER_ID = 'evidence-export';
const CALLER_ROLE = 'member';
const CONCURRENCY = 4;

export async function fetchReplayItems(
  tenantId: string,
  executionIds: string[],
  fetchImpl: typeof fetch = fetch,
  limiter: Limiter = createLimiter(CONCURRENCY),
): Promise<ReplayItemLookup> {
  const out: ReplayItemLookup = { items: new Map(), unavailable: new Set() };
  const unique = [...new Set(executionIds.filter(Boolean))];
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += RECEIPT_BATCH) batches.push(unique.slice(i, i + RECEIPT_BATCH));
  const failures: string[] = [];
  await Promise.all(batches.map((batch) => limiter(() => fetchBatch(tenantId, batch, fetchImpl, out, failures))));
  if (failures.length > 0) {
    console.warn(
      `[evidence] replay items lookup degraded: tenant=${tenantId} ` +
        `failedBatches=${failures.length}/${batches.length} firstFailure=${failures[0]}`,
    );
  }
  return out;
}

/** 合并多个租户各自的查找结果；各租户 id 互不相交，直接并集。 */
export function mergeReplayLookups(lookups: readonly ReplayItemLookup[]): ReplayItemLookup {
  const out: ReplayItemLookup = { items: new Map(), unavailable: new Set() };
  for (const l of lookups) {
    for (const [id, item] of l.items) out.items.set(id, item);
    for (const id of l.unavailable) out.unavailable.add(id);
  }
  return out;
}

/** 签名头仅在配置了 HMAC 密钥时附加；canonical 签入实际发送的原始查询串与 X-User-Id。 */
async function buildHeaders(tenantId: string, query: string): Promise<Record<string, string>> {
  const base = { 'X-Tenant-Id': tenantId, 'X-User-Id': CALLER_USER_ID, 'X-User-Role': CALLER_ROLE };
  if (!process.env.ASTER_PLAN_GATE_HMAC_KEY) return base;
  const signed = await signInternalCallerHeaders('GET', PATH, '', tenantId, CALLER_ROLE, {
    query,
    userId: CALLER_USER_ID,
  });
  return { ...base, ...signed };
}

class BatchFailure extends Error {}

function failureReason(err: unknown, timedOut: boolean): string {
  if (timedOut) return 'timeout';
  if (err instanceof BatchFailure) return err.message;
  if (err instanceof SyntaxError) return 'malformed: invalid JSON';
  return `network: ${err instanceof Error ? err.name : String(err)}`;
}

async function fetchBatch(
  tenantId: string,
  batch: string[],
  fetchImpl: typeof fetch,
  out: ReplayItemLookup,
  failures: string[],
): Promise<void> {
  // AbortController + setTimeout 而非 AbortSignal.timeout：后者不受 vitest 假定时器控制。
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), RECEIPT_TIMEOUT_MS);
  try {
    const query = `executionIds=${encodeURIComponent(batch.join(','))}`;
    const url = `${getApiConfig().baseUrl}${PATH}?${query}`;
    const headers = await buildHeaders(tenantId, query);
    const res = await fetchImpl(url, { headers, signal: ac.signal });
    if (!res.ok) throw new BatchFailure(`HTTP ${res.status}`);
    // 先完整解析再提交，畸形时不会有部分写入。
    for (const [id, item] of parseBatch(batch, await res.json())) out.items.set(id, item);
  } catch (err) {
    failures.push(failureReason(err, ac.signal.aborted));
    for (const id of batch) out.unavailable.add(id);
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function malformed(what: string): never {
  throw new BatchFailure(`malformed: ${what}`);
}

function str(item: Record<string, unknown>, field: string): string {
  const v = item[field];
  if (typeof v !== 'string') malformed(`${field} is not a string`);
  return v;
}

/** aster-api 以 NON_NULL 序列化，targetOutcome 为空时整键缺省，归一为 null。 */
function optStr(item: Record<string, unknown>, field: string): string | null {
  const v = item[field] ?? null;
  if (v !== null && typeof v !== 'string') malformed(`${field} is not a string`);
  return v;
}

function bool(item: Record<string, unknown>, field: string): boolean {
  const v = item[field];
  if (typeof v !== 'boolean') malformed(`${field} is not a boolean`);
  return v;
}

/** 只认本批请求过的 id；任一项畸形即抛错。 */
function parseBatch(batch: string[], body: unknown): Map<string, EvidenceWhatIf> {
  if (!isRecord(body) || !Array.isArray(body.items)) malformed('items is not an array');
  const wanted = new Set(batch);
  const items = new Map<string, EvidenceWhatIf>();
  for (const raw of body.items) {
    if (!isRecord(raw)) malformed('item is not an object');
    const id = str(raw, 'executionId');
    const item: EvidenceWhatIf = {
      batchId: str(raw, 'batchId'),
      baseOutcome: str(raw, 'baseOutcome'),
      targetOutcome: optStr(raw, 'targetOutcome'),
      baseLegacy: bool(raw, 'baseLegacy'),
    };
    if (wanted.has(id)) items.set(id, item);
  }
  return items;
}
