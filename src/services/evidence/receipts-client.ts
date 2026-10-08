/**
 * 向 aster-api 批量取链收据（ADR 0041 §2.4）。
 *
 * 分批 50、并发 4、每批 2 s 超时；非 2xx / 超时 / 网络错 ⇒ 该批 id 整体记入 unavailable。
 * 不重试、不伪造：取不到就如实标「不可用」，由证据包上层决定如何呈现。
 */
import 'server-only';

import { signInternalCallerHeaders } from '@/lib/api-signing';
import { getApiConfig } from '@/services/policy/policy-api';

export type ChainReceipt = {
  auditId: number;
  currentHash: string;
  prevHash: string | null;
  hashVersion: number;
  eventType: string;
  timestamp: string;
  metadata: Record<string, unknown>;
};

export type ChainApproval = {
  auditId: number;
  decisionId: string;
  outcome: string;
  decidedBy: string;
  requiredRole: string | null;
  comment: string | null;
  decidedAt: string;
  currentHash: string;
  decisionReceiptHash: string | null;
};

/**
 * receipts 以请求 id（correlationId 或 decisionId）为键；approvals 以 decisionId 聚合，
 * 且只有 fetchDecisionReceipts 会填充——fetchReceipts（按 correlationId 查）的 approvals 恒为空。
 */
export type ReceiptLookup = {
  receipts: Map<string, ChainReceipt>;
  approvals: Map<string, ChainApproval[]>;
  missing: Set<string>;
  unavailable: Set<string>;
};

// 50：200 个 UUID 级 id 的查询串会超出 Quarkus 默认 4096 字节请求行上限。
export const RECEIPT_BATCH = 50;
export const RECEIPT_TIMEOUT_MS = 2000;
export const RECEIPT_CONCURRENCY = 4;

const PATH = '/api/v1/audit/receipts';
// 服务间调用的身份：只读审计收据，按最低角色 member 访问。
const CALLER_USER_ID = 'evidence-export';
const CALLER_ROLE = 'member';

type LookupParam = 'correlationIds' | 'decisionIds';
// 线上响应里的收据带回请求键（correlationId / decisionId），对外类型不暴露它。
type WireReceipt = ChainReceipt & { correlationId?: string; decisionId?: string };

const KEY_OF: Record<LookupParam, 'correlationId' | 'decisionId'> = {
  correlationIds: 'correlationId',
  decisionIds: 'decisionId',
};

/** 按 correlationId 取收据；返回的 approvals 恒为空（审批只经 fetchDecisionReceipts 取得）。 */
export async function fetchReceipts(
  tenantId: string,
  correlationIds: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<ReceiptLookup> {
  return lookup(tenantId, 'correlationIds', correlationIds, fetchImpl);
}

export async function fetchDecisionReceipts(
  tenantId: string,
  decisionIds: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<ReceiptLookup> {
  return lookup(tenantId, 'decisionIds', decisionIds, fetchImpl);
}

/**
 * 合并多个租户各自的查找结果（导出按租户分组查询后拼回一份）。
 * 各租户的 id 互不相交，故直接并集；同一 decisionId 的审批列表按出现顺序拼接。
 */
export function mergeLookups(lookups: readonly ReceiptLookup[]): ReceiptLookup {
  const out: ReceiptLookup = { receipts: new Map(), approvals: new Map(), missing: new Set(), unavailable: new Set() };
  for (const l of lookups) {
    for (const [id, r] of l.receipts) out.receipts.set(id, r);
    for (const [id, list] of l.approvals) out.approvals.set(id, [...(out.approvals.get(id) ?? []), ...list]);
    for (const id of l.missing) out.missing.add(id);
    for (const id of l.unavailable) out.unavailable.add(id);
  }
  return out;
}

async function lookup(
  tenantId: string,
  param: LookupParam,
  ids: string[],
  fetchImpl: typeof fetch,
): Promise<ReceiptLookup> {
  const out: ReceiptLookup = { receipts: new Map(), approvals: new Map(), missing: new Set(), unavailable: new Set() };
  const unique = [...new Set(ids.filter(Boolean))];
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += RECEIPT_BATCH) batches.push(unique.slice(i, i + RECEIPT_BATCH));
  const tasks = batches.map((batch) => () => fetchBatch(tenantId, param, batch, fetchImpl, out));
  await runLimited(tasks, RECEIPT_CONCURRENCY);
  return out;
}

/** 签名头仅在配置了 HMAC 密钥时附加（本地开发无密钥时仍可调用未开启校验的后端）。 */
async function buildHeaders(tenantId: string): Promise<Record<string, string>> {
  const base = { 'X-Tenant-Id': tenantId, 'X-User-Id': CALLER_USER_ID, 'X-User-Role': CALLER_ROLE };
  if (!process.env.ASTER_PLAN_GATE_HMAC_KEY) return base;
  const signed = await signInternalCallerHeaders('GET', PATH, '', tenantId, CALLER_ROLE);
  return { ...base, ...signed };
}

async function fetchBatch(
  tenantId: string,
  param: LookupParam,
  batch: string[],
  fetchImpl: typeof fetch,
  out: ReceiptLookup,
): Promise<void> {
  // 用 AbortController + setTimeout 而非 AbortSignal.timeout：后者不受 vitest 假定时器控制。
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), RECEIPT_TIMEOUT_MS);
  try {
    const url = `${getApiConfig().baseUrl}${PATH}?${param}=${encodeURIComponent(batch.join(','))}`;
    const headers = await buildHeaders(tenantId);
    const res = await fetchImpl(url, { headers, signal: ac.signal });
    if (!res.ok) throw new Error(`receipts HTTP ${res.status}`);
    commitBatch(out, parseBatch(KEY_OF[param], batch, await res.json()));
  } catch {
    // 超时、网络错、非 2xx、响应畸形：整批记不可用，不重试；parseBatch 先于提交，故不会有部分写入。
    markUnavailable(out, batch);
  } finally {
    clearTimeout(timer);
  }
}

function markUnavailable(out: ReceiptLookup, batch: string[]): void {
  for (const id of batch) out.unavailable.add(id);
}

type BatchResult = { receipts: Map<string, ChainReceipt>; approvals: ChainApproval[]; missing: string[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function arrayField(body: Record<string, unknown>, field: string): unknown[] {
  const v = body[field] ?? [];
  if (!Array.isArray(v)) throw new Error(`receipts body: ${field} is not an array`);
  return v;
}

/**
 * 把一批响应解析为本地结果；畸形即抛错（尚未触碰 out）。
 * 只认本批请求过的 id：missing = 本批 id − 收到收据的 id（不采信服务端 missing 列表），
 * 故 receipts / missing / unavailable 三集合按构造互斥。
 */
function parseBatch(key: 'correlationId' | 'decisionId', batch: string[], body: unknown): BatchResult {
  if (!isRecord(body)) throw new Error('receipts body is not an object');
  const wanted = new Set(batch);
  const receipts = new Map<string, ChainReceipt>();
  for (const item of arrayField(body, 'receipts')) {
    if (!isRecord(item)) throw new Error('receipt is not an object');
    const { correlationId, decisionId, ...receipt } = item as WireReceipt;
    const id = key === 'correlationId' ? correlationId : decisionId;
    if (typeof id === 'string' && wanted.has(id)) receipts.set(id, receipt);
  }
  // 审批按 decisionId 归属：只保留本批请求过的 decisionId（即仅 decisionIds 查询有意义）。
  const approvals: ChainApproval[] = [];
  for (const item of arrayField(body, 'approvals')) {
    if (!isRecord(item)) throw new Error('approval is not an object');
    const a = item as ChainApproval;
    if (typeof a.decisionId === 'string' && wanted.has(a.decisionId)) approvals.push(a);
  }
  arrayField(body, 'missing');
  const missing = batch.filter((id) => !receipts.has(id));
  return { receipts, approvals, missing };
}

function commitBatch(out: ReceiptLookup, result: BatchResult): void {
  for (const [id, r] of result.receipts) out.receipts.set(id, r);
  for (const a of result.approvals) {
    const list = out.approvals.get(a.decisionId) ?? [];
    list.push(a);
    out.approvals.set(a.decisionId, list);
  }
  for (const id of result.missing) out.missing.add(id);
}

/** 有界并发：同一时刻最多 limit 个任务在跑；任务自身吞掉错误、永不抛出。 */
async function runLimited(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) await tasks[next++]();
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}
