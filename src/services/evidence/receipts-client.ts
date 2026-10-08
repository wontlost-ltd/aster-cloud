/**
 * 向 aster-api 批量取链收据（ADR 0041 §2.4）。
 *
 * 分批 200、并发 4、每批 2 s 超时；非 2xx / 超时 / 网络错 ⇒ 该批 id 整体记入 unavailable。
 * 不重试、不伪造：取不到就如实标「不可用」，由证据包上层决定如何呈现。
 */
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

/** receipts 以请求 id（correlationId 或 decisionId）为键；approvals 以 decisionId 聚合。 */
export type ReceiptLookup = {
  receipts: Map<string, ChainReceipt>;
  approvals: Map<string, ChainApproval[]>;
  missing: Set<string>;
  unavailable: Set<string>;
};

export const RECEIPT_BATCH = 200;
export const RECEIPT_TIMEOUT_MS = 2000;
export const RECEIPT_CONCURRENCY = 4;

const PATH = '/api/v1/audit/receipts';
// 服务间调用的身份：只读审计收据，按最低角色 member 访问。
const CALLER_USER_ID = 'evidence-export';
const CALLER_ROLE = 'member';

type LookupParam = 'correlationIds' | 'decisionIds';
// 线上响应里的收据带回请求键（correlationId / decisionId），对外类型不暴露它。
type WireReceipt = ChainReceipt & { correlationId?: string; decisionId?: string };
type WireBody = { receipts?: WireReceipt[]; approvals?: ChainApproval[]; missing?: string[] };

const KEY_OF: Record<LookupParam, 'correlationId' | 'decisionId'> = {
  correlationIds: 'correlationId',
  decisionIds: 'decisionId',
};

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
  try {
    const url = `${getApiConfig().baseUrl}${PATH}?${param}=${encodeURIComponent(batch.join(','))}`;
    const headers = await buildHeaders(tenantId);
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(RECEIPT_TIMEOUT_MS) });
    if (!res.ok) {
      markUnavailable(out, batch);
      return;
    }
    mergeBody(out, KEY_OF[param], (await res.json()) as WireBody);
  } catch {
    // 超时（AbortSignal.timeout ⇒ TimeoutError）、网络错、响应非 JSON：整批记不可用，不重试。
    markUnavailable(out, batch);
  }
}

function markUnavailable(out: ReceiptLookup, batch: string[]): void {
  for (const id of batch) out.unavailable.add(id);
}

function mergeBody(out: ReceiptLookup, key: 'correlationId' | 'decisionId', body: WireBody): void {
  for (const wire of body.receipts ?? []) {
    const id = wire[key];
    if (!id) continue;
    const { correlationId: _c, decisionId: _d, ...receipt } = wire;
    out.receipts.set(id, receipt);
  }
  for (const a of body.approvals ?? []) {
    const list = out.approvals.get(a.decisionId) ?? [];
    list.push(a);
    out.approvals.set(a.decisionId, list);
  }
  for (const m of body.missing ?? []) out.missing.add(m);
}

/** 有界并发：同一时刻最多 limit 个任务在跑；任务自身吞掉错误、永不抛出。 */
async function runLimited(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) await tasks[next++]();
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}
