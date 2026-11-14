/**
 * 向 aster-api 批量取链收据（ADR 0041 §2.4）。
 *
 * 分批 50、并发 4、每批 2 s 超时；非 2xx / 超时 / 网络错 / 响应畸形 ⇒ 该批 id 整体记入 unavailable。
 * 不重试、不伪造：取不到就如实标「不可用」，由证据包上层决定如何呈现。
 * 每次查找的首个失败原因只写服务端日志（console.warn），绝不进入证据包。
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
  /** 决策收据专有（ADR 0041 §12 D2）：guard_receipts.consume_audit_id，即权威消耗尝试事件；未消耗或非决策收据为 null。 */
  authoritativeConsumeAuditId: number | null;
};

export type ChainApproval = {
  auditId: number;
  decisionId: string;
  outcome: string;
  decidedBy: string | null;
  requiredRole: string | null;
  comment: string | null;
  decidedAt: string;
  currentHash: string;
  decisionReceiptHash: string | null;
  /** 审批快照四键（ADR 0042 §12 D6）：旧 api、旧事件与过期事件没有，归一为 null。 */
  inputSnapshotHash: string | null;
  inputSnapshotMatched: boolean | null;
  inputRevealed: boolean | null;
  inputStatus: string | null;
};

/**
 * 一次 consume 尝试（ADR 0041 §12 D2）。只有 guard_receipts.consume_audit_id 所指的那条 authoritative=true；
 * 判定是否消耗只看决策收据的 authoritativeConsumeAuditId，不数尝试事件、不看 outcome。
 */
export type ChainConsume = {
  auditId: number;
  currentHash: string;
  decisionId: string;
  authoritative: boolean;
  attemptId: string | null;
  executorId: string | null;
  outcome: string | null;
};

/** 一次执行结果回写（ADR 0041 §12 D2）；authoritative 表示是否为 guard_receipts.result_audit_id 所指。 */
export type ChainResult = {
  auditId: number;
  currentHash: string;
  decisionId: string;
  authoritative: boolean;
  attemptId: string | null;
  executorId: string | null;
  status: string | null;
};

/**
 * receipts 以请求 id（correlationId 或 decisionId）为键；approvals / consumes / results 以 decisionId 聚合，
 * 且只有 fetchDecisionReceipts 会填充——fetchReceipts（按 correlationId 查）的这三项恒为空。
 */
export type ReceiptLookup = {
  receipts: Map<string, ChainReceipt>;
  approvals: Map<string, ChainApproval[]>;
  consumes: Map<string, ChainConsume[]>;
  results: Map<string, ChainResult[]>;
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

const KEY_OF: Record<LookupParam, 'correlationId' | 'decisionId'> = {
  correlationIds: 'correlationId',
  decisionIds: 'decisionId',
};

/** 按 correlationId 取收据；返回的 approvals 恒为空（审批只经 fetchDecisionReceipts 取得）。 */
export async function fetchReceipts(
  tenantId: string,
  correlationIds: string[],
  fetchImpl: typeof fetch = fetch,
  limiter: Limiter = createLimiter(RECEIPT_CONCURRENCY),
): Promise<ReceiptLookup> {
  return lookup(tenantId, 'correlationIds', correlationIds, fetchImpl, limiter);
}

export async function fetchDecisionReceipts(
  tenantId: string,
  decisionIds: string[],
  fetchImpl: typeof fetch = fetch,
  limiter: Limiter = createLimiter(RECEIPT_CONCURRENCY),
): Promise<ReceiptLookup> {
  return lookup(tenantId, 'decisionIds', decisionIds, fetchImpl, limiter);
}

/** 空查找结果。 */
export function emptyLookup(): ReceiptLookup {
  return {
    receipts: new Map(), approvals: new Map(), consumes: new Map(), results: new Map(),
    missing: new Set(), unavailable: new Set(),
  };
}

/**
 * 合并多个租户各自的查找结果（导出按租户分组查询后拼回一份）。
 * 各租户的 id 互不相交，故直接并集；同一 decisionId 的审批列表按出现顺序拼接。
 */
export function mergeLookups(lookups: readonly ReceiptLookup[]): ReceiptLookup {
  const out = emptyLookup();
  for (const l of lookups) {
    for (const [id, r] of l.receipts) out.receipts.set(id, r);
    for (const [id, list] of l.approvals) out.approvals.set(id, [...(out.approvals.get(id) ?? []), ...list]);
    for (const [id, list] of l.consumes) out.consumes.set(id, [...(out.consumes.get(id) ?? []), ...list]);
    for (const [id, list] of l.results) out.results.set(id, [...(out.results.get(id) ?? []), ...list]);
    for (const id of l.missing) out.missing.add(id);
    for (const id of l.unavailable) out.unavailable.add(id);
  }
  return out;
}

/**
 * 有界并发限流器：同一时刻最多 limit 个任务在跑。
 * 导出层用同一个实例串起所有租户、两类查找，使对 aster-api 的在途批次全局不超过 limit。
 */
export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

export function createLimiter(limit: number): Limiter {
  let active = 0;
  const queue: Array<() => void> = [];
  // 有人排队则把名额直接移交给队首（active 不变），否则归还名额。
  const release = () => {
    const next = queue.shift();
    if (next) next();
    else active--;
  };
  return async (task) => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    else active++;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

async function lookup(
  tenantId: string,
  param: LookupParam,
  ids: string[],
  fetchImpl: typeof fetch,
  limiter: Limiter,
): Promise<ReceiptLookup> {
  const out = emptyLookup();
  const unique = [...new Set(ids.filter(Boolean))];
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += RECEIPT_BATCH) batches.push(unique.slice(i, i + RECEIPT_BATCH));
  const failures: string[] = [];
  await Promise.all(
    batches.map((batch) => limiter(() => fetchBatch(tenantId, param, batch, fetchImpl, out, failures))),
  );
  if (failures.length > 0) {
    console.warn(
      `[evidence] receipts lookup degraded: tenant=${tenantId} param=${param} ` +
        `failedBatches=${failures.length}/${batches.length} firstFailure=${failures[0]}`,
    );
  }
  return out;
}

/**
 * 签名头仅在配置了 HMAC 密钥时附加（本地开发无密钥时仍可调用未开启校验的后端）。
 * canonical v3 签入实际发送的原始查询串与 X-User-Id，防止改写 correlationIds/decisionIds（ADR 0042 §4.1）。
 */
async function buildHeaders(tenantId: string, query: string): Promise<Record<string, string>> {
  const base = { 'X-Tenant-Id': tenantId, 'X-User-Id': CALLER_USER_ID, 'X-User-Role': CALLER_ROLE };
  if (!process.env.ASTER_PLAN_GATE_HMAC_KEY) return base;
  const signed = await signInternalCallerHeaders('GET', PATH, '', tenantId, CALLER_ROLE, {
    query,
    userId: CALLER_USER_ID,
  });
  return { ...base, ...signed };
}

/** 可归类的批失败（HTTP 状态 / 响应畸形），message 即诊断原因。 */
class BatchFailure extends Error {}

/** 把批失败归为 timeout / HTTP xxx / malformed:… / network:…，仅用于日志诊断。 */
function failureReason(err: unknown, timedOut: boolean): string {
  if (timedOut) return 'timeout';
  if (err instanceof BatchFailure) return err.message;
  if (err instanceof SyntaxError) return 'malformed: invalid JSON';
  return `network: ${err instanceof Error ? err.name : String(err)}`;
}

async function fetchBatch(
  tenantId: string,
  param: LookupParam,
  batch: string[],
  fetchImpl: typeof fetch,
  out: ReceiptLookup,
  failures: string[],
): Promise<void> {
  // 用 AbortController + setTimeout 而非 AbortSignal.timeout：后者不受 vitest 假定时器控制。
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), RECEIPT_TIMEOUT_MS);
  try {
    const query = `${param}=${encodeURIComponent(batch.join(','))}`;
    const url = `${getApiConfig().baseUrl}${PATH}?${query}`;
    const headers = await buildHeaders(tenantId, query);
    const res = await fetchImpl(url, { headers, signal: ac.signal });
    if (!res.ok) throw new BatchFailure(`HTTP ${res.status}`);
    commitBatch(out, parseBatch(KEY_OF[param], batch, await res.json()));
  } catch (err) {
    // 超时、网络错、非 2xx、响应畸形：整批记不可用，不重试；parseBatch 先于提交，故不会有部分写入。
    failures.push(failureReason(err, ac.signal.aborted));
    markUnavailable(out, batch);
  } finally {
    clearTimeout(timer);
  }
}

function markUnavailable(out: ReceiptLookup, batch: string[]): void {
  for (const id of batch) out.unavailable.add(id);
}

type BatchResult = {
  receipts: Map<string, ChainReceipt>;
  approvals: ChainApproval[];
  consumes: ChainConsume[];
  results: ChainResult[];
  missing: string[];
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function malformed(what: string): never {
  throw new BatchFailure(`malformed: ${what}`);
}

function arrayField(body: Record<string, unknown>, field: string): unknown[] {
  const v = body[field] ?? [];
  if (!Array.isArray(v)) malformed(`${field} is not an array`);
  return v;
}

/** 必填字符串字段；缺失或类型不符即畸形。 */
function str(item: Record<string, unknown>, field: string): string {
  const v = item[field];
  if (typeof v !== 'string') malformed(`${field} is not a string`);
  return v;
}

/** 必填有限数字字段；缺失或类型不符即畸形。 */
function num(item: Record<string, unknown>, field: string): number {
  const v = item[field];
  if (typeof v !== 'number' || !Number.isFinite(v)) malformed(`${field} is not a number`);
  return v;
}

/** 可空字符串字段：aster-api 以 NON_NULL 序列化，null 值整键缺省，故缺省归一为 null。 */
function optStr(item: Record<string, unknown>, field: string): string | null {
  const v = item[field] ?? null;
  if (v !== null && typeof v !== 'string') malformed(`${field} is not a string`);
  return v;
}

/** 可空有限数字字段：缺省归一为 null。 */
function optNum(item: Record<string, unknown>, field: string): number | null {
  const v = item[field] ?? null;
  if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) malformed(`${field} is not a number`);
  return v;
}

/** 可空布尔字段：缺省归一为 null。 */
function optBool(item: Record<string, unknown>, field: string): boolean | null {
  const v = item[field] ?? null;
  if (v !== null && typeof v !== 'boolean') malformed(`${field} is not a boolean`);
  return v;
}

/** 必填布尔字段；缺失或类型不符即畸形。 */
function bool(item: Record<string, unknown>, field: string): boolean {
  const v = item[field];
  if (typeof v !== 'boolean') malformed(`${field} is not a boolean`);
  return v;
}

/** 决策收据 metadata 中进证据包的来源列表键（ADR 0041 §11 D1）。 */
const INPUT_SOURCE_LIST_KEYS = ['verifiedFields', 'factIssuers', 'factSources', 'unverifiedFields'] as const;

/**
 * 证据包会读取的 metadata 键做类型校验（ADR 0042 §12 D9）：存在却类型不符即畸形，整批记 unavailable，
 * 不静默丢元素——否则 guardInputSources 会少项而审计方无从察觉。键缺省（旧事件）照常放行。
 */
function checkEvidenceMetadata(metadata: Record<string, unknown>): void {
  for (const key of INPUT_SOURCE_LIST_KEYS) {
    const v = metadata[key];
    if (v !== undefined && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) {
      malformed(`metadata.${key} is not a string array`);
    }
  }
  if (metadata.inputSourcesTruncated !== undefined && typeof metadata.inputSourcesTruncated !== 'boolean') {
    malformed('metadata.inputSourcesTruncated is not a boolean');
  }
  if (metadata.inputSource !== undefined && typeof metadata.inputSource !== 'string') {
    malformed('metadata.inputSource is not a string');
  }
}

/**
 * 线上收据 → 精确的 ChainReceipt（不透传多余键，不留 undefined，保证 canonicalHash 可算）。
 * prevHash 缺省 = 链首行，归一为 null；hashVersion 缺省 = 链前旧行，无法校验 ⇒ 畸形。
 */
function toReceipt(item: Record<string, unknown>): ChainReceipt {
  const metadata = item.metadata ?? {};
  if (!isRecord(metadata)) malformed('metadata is not an object');
  checkEvidenceMetadata(metadata);
  return {
    auditId: num(item, 'auditId'),
    currentHash: str(item, 'currentHash'),
    prevHash: optStr(item, 'prevHash'),
    hashVersion: num(item, 'hashVersion'),
    eventType: str(item, 'eventType'),
    timestamp: str(item, 'timestamp'),
    metadata,
    authoritativeConsumeAuditId: optNum(item, 'authoritativeConsumeAuditId'),
  };
}

/** 线上审批 → 精确的 ChainApproval；decidedBy / comment / requiredRole / decisionReceiptHash 缺省归一为 null。 */
function toApproval(item: Record<string, unknown>): ChainApproval {
  return {
    auditId: num(item, 'auditId'),
    decisionId: str(item, 'decisionId'),
    outcome: str(item, 'outcome'),
    decidedBy: optStr(item, 'decidedBy'),
    requiredRole: optStr(item, 'requiredRole'),
    comment: optStr(item, 'comment'),
    decidedAt: str(item, 'decidedAt'),
    currentHash: str(item, 'currentHash'),
    decisionReceiptHash: optStr(item, 'decisionReceiptHash'),
    inputSnapshotHash: optStr(item, 'inputSnapshotHash'),
    inputSnapshotMatched: optBool(item, 'inputSnapshotMatched'),
    inputRevealed: optBool(item, 'inputRevealed'),
    inputStatus: optStr(item, 'inputStatus'),
  };
}

/** 线上 consume 尝试 → 精确的 ChainConsume；可空字段缺省归一为 null。 */
function toConsume(item: Record<string, unknown>): ChainConsume {
  return {
    auditId: num(item, 'auditId'),
    currentHash: str(item, 'currentHash'),
    decisionId: str(item, 'decisionId'),
    authoritative: bool(item, 'authoritative'),
    attemptId: optStr(item, 'attemptId'),
    executorId: optStr(item, 'executorId'),
    outcome: optStr(item, 'outcome'),
  };
}

/** 线上执行结果 → 精确的 ChainResult；可空字段缺省归一为 null。 */
function toResult(item: Record<string, unknown>): ChainResult {
  return {
    auditId: num(item, 'auditId'),
    currentHash: str(item, 'currentHash'),
    decisionId: str(item, 'decisionId'),
    authoritative: bool(item, 'authoritative'),
    attemptId: optStr(item, 'attemptId'),
    executorId: optStr(item, 'executorId'),
    status: optStr(item, 'status'),
  };
}

/** 解析一个按 decisionId 归属的数组字段，只保留本批请求过的 decisionId。 */
function decisionItems<T extends { decisionId: string }>(
  body: Record<string, unknown>,
  field: string,
  wanted: ReadonlySet<string>,
  parse: (item: Record<string, unknown>) => T,
): T[] {
  const out: T[] = [];
  for (const item of arrayField(body, field)) {
    if (!isRecord(item)) malformed(`${field} item is not an object`);
    const parsed = parse(item);
    if (wanted.has(parsed.decisionId)) out.push(parsed);
  }
  return out;
}

/**
 * 把一批响应解析为本地结果；任一条畸形即抛错（尚未触碰 out），整批记 unavailable。
 * 只认本批请求过的 id：missing = 本批 id − 收到收据的 id（不采信服务端 missing 列表），
 * 故 receipts / missing / unavailable 三集合按构造互斥。
 */
function parseBatch(key: 'correlationId' | 'decisionId', batch: string[], body: unknown): BatchResult {
  if (!isRecord(body)) malformed('body is not an object');
  const wanted = new Set(batch);
  const receipts = new Map<string, ChainReceipt>();
  for (const item of arrayField(body, 'receipts')) {
    if (!isRecord(item)) malformed('receipt is not an object');
    const receipt = toReceipt(item);
    const id = optStr(item, key);
    if (id !== null && wanted.has(id)) receipts.set(id, receipt);
  }
  // 审批 / 消耗 / 结果按 decisionId 归属：只保留本批请求过的 decisionId（即仅 decisionIds 查询有意义）。
  // reveals[] 不解析：解除记录不进证据包（ADR 0042 §12 D9），留在链上经收据接口可查。
  const approvals = decisionItems(body, 'approvals', wanted, toApproval);
  const consumes = decisionItems(body, 'consumes', wanted, toConsume);
  const results = decisionItems(body, 'results', wanted, toResult);
  arrayField(body, 'missing');
  const missing = batch.filter((id) => !receipts.has(id));
  return { receipts, approvals, consumes, results, missing };
}

function groupInto<T extends { decisionId: string }>(target: Map<string, T[]>, items: readonly T[]): void {
  for (const item of items) {
    const list = target.get(item.decisionId) ?? [];
    list.push(item);
    target.set(item.decisionId, list);
  }
}

function commitBatch(out: ReceiptLookup, result: BatchResult): void {
  for (const [id, r] of result.receipts) out.receipts.set(id, r);
  groupInto(out.approvals, result.approvals);
  groupInto(out.consumes, result.consumes);
  groupInto(out.results, result.results);
  for (const id of result.missing) out.missing.add(id);
}
