import 'server-only';

import { signAsterApiV2Headers } from '@/lib/api-signing';
import { resolvePolicyApiBaseUrl } from '@/lib/policy-api-url';
import { safeEnv } from '@/lib/runtime/safe-env';
import { newTraceContext } from '@/lib/trace-context';

/**
 * aster-api 孤儿通知源（ADR 0065 §3.4.2）的 HTTP 客户端。
 * 请求按 v2 canonical 签名；缺 key 时在发请求前失败，绝不发未签名请求。
 */

const FEED_PATH = '/api/internal/guard/orphan-feed';
const DEFAULT_TIMEOUT_MS = 8000;

export interface OrphanFeedTenantsPage {
  items: { tenantId: string; maxId: number }[];
  next?: string;
}

export interface OrphanFeedSummary {
  tenantId: string;
  maxId: number;
  total: number;
  byKind: Record<string, number>;
  firstDetectedAt?: string;
  lastDetectedAt?: string;
  runIds: number[];
}

export interface OrphanFeed {
  tenants(q: { detectedSince: string; afterTenant?: string; limit?: number }): Promise<OrphanFeedTenantsPage>;
  summary(q: { tenantId: string; afterId: number; detectedSince: string }): Promise<OrphanFeedSummary>;
}

/** status 为 0 表示请求未发出或网络 / 超时失败。 */
export class OrphanFeedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`orphan feed ${status} ${code}`);
    this.name = 'OrphanFeedError';
  }
}

const malformed = () => new OrphanFeedError(200, 'malformed_response');

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function optionalTime(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw malformed();
  return v;
}

function parseTenantsPage(raw: unknown): OrphanFeedTenantsPage {
  if (!isRecord(raw) || !Array.isArray(raw.items)) throw malformed();
  const items = raw.items.map((it) => {
    if (!isRecord(it) || !isNonEmptyString(it.tenantId) || !isCount(it.maxId)) throw malformed();
    return { tenantId: it.tenantId, maxId: it.maxId };
  });
  if (raw.next !== undefined && typeof raw.next !== 'string') throw malformed();
  return raw.next === undefined ? { items } : { items, next: raw.next };
}

function parseSummary(raw: unknown): OrphanFeedSummary {
  if (!isRecord(raw) || !isNonEmptyString(raw.tenantId) || !isCount(raw.maxId) || !isCount(raw.total)) {
    throw malformed();
  }
  if (!isRecord(raw.byKind) || !Object.values(raw.byKind).every(isCount)) throw malformed();
  if (!Array.isArray(raw.runIds) || !raw.runIds.every(isCount)) throw malformed();
  const out: OrphanFeedSummary = {
    tenantId: raw.tenantId,
    maxId: raw.maxId,
    total: raw.total,
    byKind: raw.byKind as Record<string, number>,
    runIds: raw.runIds as number[],
  };
  const first = optionalTime(raw.firstDetectedAt);
  const last = optionalTime(raw.lastDetectedAt);
  if (first !== undefined) out.firstDetectedAt = first;
  if (last !== undefined) out.lastDetectedAt = last;
  return out;
}

/** 错误体可能是纯文本或任意 JSON：只认字符串型 `error`，其余回落 `http_<status>`。 */
async function errorCodeOf(res: Response): Promise<string> {
  try {
    const body: unknown = JSON.parse(await res.text());
    if (isRecord(body) && typeof body.error === 'string' && body.error.length > 0) return body.error;
  } catch {
    // 非 JSON 响应体：回落到状态码
  }
  return `http_${res.status}`;
}

export interface OrphanFeedClientOptions {
  baseUrl?: string;
  /** 显式传 null 表示未配置；不传则读 ASTER_PLAN_GATE_HMAC_KEY。 */
  hmacKey?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createOrphanFeedClient(opts: OrphanFeedClientOptions = {}): OrphanFeed {
  // 与其它 aster-api 调用方同一套解析：显式配置优先，未配置时回落到生产 aster-api 公网地址。
  // 不能回落到集群内地址：cloud 跑在 Cloudflare Worker 上，http://aster-api:8080 不可达（Cloudflare 直接返回 403）。
  const baseUrl =
    opts.baseUrl ??
    resolvePolicyApiBaseUrl(
      safeEnv('ASTER_API_INTERNAL_URL'),
      safeEnv('ASTER_POLICY_API_INTERNAL_URL'),
      safeEnv('NEXT_PUBLIC_ASTER_POLICY_API_URL'),
    );
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function post<T>(endpoint: string, query: object, parse: (raw: unknown) => T): Promise<T> {
    const hmacKey = opts.hmacKey === undefined ? safeEnv('ASTER_PLAN_GATE_HMAC_KEY') : opts.hmacKey;
    if (!hmacKey) throw new OrphanFeedError(0, 'hmac_not_configured');

    const path = `${FEED_PATH}/${endpoint}`;
    const body = JSON.stringify(query);
    const signed = await signAsterApiV2Headers('POST', path, body, hmacKey);

    let res: Response;
    try {
      res = await (opts.fetchImpl ?? fetch)(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          traceparent: newTraceContext().traceparent,
          ...signed,
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new OrphanFeedError(0, 'unreachable');
    }
    if (!res.ok) throw new OrphanFeedError(res.status, await errorCodeOf(res));

    let raw: unknown;
    try {
      raw = JSON.parse(await res.text());
    } catch {
      throw malformed();
    }
    return parse(raw);
  }

  return {
    tenants: (q) => post('tenants', q, parseTenantsPage),
    summary: (q) => post('summary', q, parseSummary),
  };
}
