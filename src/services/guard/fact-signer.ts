/**
 * 服务端签发端（ADR 0046 §11 D5 第 2 项；ADR 0040 §11 D3 事实格式）。
 *
 * 输入只有 `{ path, source, args }`：值一律由来源函数清单（`@/config/fact-sources`）在服务端取得，
 * 带 `value` / `claims` 键的请求直接拒绝（裁定 8：不签调用方提供的数据）。每个 claim 在签名**之前**与 action
 * 线上形态（`JSON.stringify` 后再解析，即 aster-api 收到的原文树）对应路径的值做 JCS 字节比对，并按 aster-api
 * `FactVerifier` 同一口径检查点号字面键歧义；不满足的 claim 丢弃并记原因，永不发出会让整个 from-evidence 400
 * `invalid_fact` 的事实。至多产出 1 条事实。
 *
 * 签名载荷 `{ alg, audience, claims, expiresAt, issuedAt, issuer, kid, sources }` 的 RFC 8785 字节串由 Ed25519 直接签名，
 * 签名 base64url 无填充（64 字节）。`audience` 即租户 id，跨租户重放不成立。
 */
import { type FactSource, type FactSourceContext, pathAllowed } from '@/config/fact-sources';
import { JcsError, jcsCanonicalize } from '@/lib/jcs';
import type { FactSigningKey } from '@/services/guard/fact-signing-key';
import type { GuardAction, GuardFact } from '@/services/policy/guard-types';

export type { GuardFact } from '@/services/policy/guard-types';

/** 事实有效期 10 分钟（aster-api 上限 24h）；from-evidence 在签名后立即发出。 */
export const FACT_TTL_MS = 600_000;
/** 与 aster-api FactVerifier.MAX_CLAIMS / MAX_PATH_LENGTH 一致。 */
const MAX_REQUESTS = 64;
const MAX_PATH_LENGTH = 128;
const REQUEST_KEYS = new Set(['path', 'source', 'args']);
const RAW_VALUE_KEYS = ['value', 'claims'];

export interface FactRequest {
  path: string;
  source: string;
  args?: Record<string, unknown>;
}

export type FactSignerErrorCode = 'claims_not_allowed' | 'unknown_fact_source' | 'path_not_allowed' | 'invalid_fact_request';

export class FactSignerError extends Error {
  readonly status = 400;
  constructor(readonly code: FactSignerErrorCode, readonly path?: string) {
    super(code);
    this.name = 'FactSignerError';
  }
}

export type SkipReason = 'unresolved' | 'value_mismatch' | 'ambiguous_path';

export interface SignFactsResult {
  fact: GuardFact | null;
  skipped: Array<{ path: string; reason: SkipReason }>;
}

export interface SignFactsInput {
  ctx: FactSourceContext;
  requests: unknown[];
  action: GuardAction;
  key: FactSigningKey;
  sources: ReadonlyMap<string, FactSource>;
  now: Date;
}

interface ValidRequest {
  path: string;
  source: FactSource;
  args: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH_LENGTH;
}

/** 单项结构校验；原值键优先报 claims_not_allowed（带上 path 以便定位）。 */
function validateOne(item: unknown, sources: ReadonlyMap<string, FactSource>): ValidRequest {
  if (!isPlainObject(item)) throw new FactSignerError('invalid_fact_request');
  const path = typeof item.path === 'string' ? item.path : undefined;
  if (RAW_VALUE_KEYS.some((k) => k in item)) throw new FactSignerError('claims_not_allowed', path);
  if (Object.keys(item).some((k) => !REQUEST_KEYS.has(k))) throw new FactSignerError('invalid_fact_request', path);
  if (!validPath(item.path) || typeof item.source !== 'string') throw new FactSignerError('invalid_fact_request', path);
  if (item.args !== undefined && !isPlainObject(item.args)) throw new FactSignerError('invalid_fact_request', path);
  const source = sources.get(item.source);
  if (!source) throw new FactSignerError('unknown_fact_source', item.path);
  if (!pathAllowed(source.allowedPaths, item.path)) throw new FactSignerError('path_not_allowed', item.path);
  return { path: item.path, source, args: (item.args as Record<string, unknown> | undefined) ?? {} };
}

/** 先整体校验（任一项不合规即整体拒绝，且不调用任何来源函数），再逐项取值。 */
function validateAll(requests: unknown, sources: ReadonlyMap<string, FactSource>): ValidRequest[] {
  if (!Array.isArray(requests) || requests.length > MAX_REQUESTS) throw new FactSignerError('invalid_fact_request');
  const out = requests.map((item) => validateOne(item, sources));
  const paths = new Set(out.map((r) => r.path));
  if (paths.size !== out.length) throw new FactSignerError('invalid_fact_request');
  return out;
}

/** 点路径只沿对象成员下行（数组不是对象）；任一段缺失返回 absent，显式 null 叶子是存在的值。同 FactVerifier.resolve。 */
function valueAtPath(root: unknown, path: string): { found: boolean; value?: unknown } {
  let node = root;
  for (const segment of path.split('.')) {
    if (!isPlainObject(node) || !Object.prototype.hasOwnProperty.call(node, segment)) return { found: false };
    node = node[segment];
  }
  return { found: true, value: node };
}

function collides(dotted: string, path: string): boolean {
  return dotted === path || path.startsWith(`${dotted}.`) || dotted.startsWith(`${path}.`);
}

/**
 * 与 FactVerifier.requireUnambiguous 同口径：沿路径经过的每个对象里，含 '.' 的字面键拼成的点路径与 claim 路径
 * 相等或互为前缀 → 歧义（aster-api 会以 ambiguous_path 拒绝整个请求）。claim 覆盖的值内部不检查。
 */
function isAmbiguous(root: unknown, path: string): boolean {
  let node = root;
  let prefix = '';
  for (const segment of path.split('.')) {
    if (!isPlainObject(node)) return false;
    for (const key of Object.keys(node)) {
      const dotted = prefix ? `${prefix}.${key}` : key;
      if (key.includes('.') && collides(dotted, path)) return true;
    }
    prefix = prefix ? `${prefix}.${segment}` : segment;
    node = node[segment];
  }
  return false;
}

function canonicalOrNull(value: unknown): string | null {
  try {
    return jcsCanonicalize(value);
  } catch (e) {
    if (e instanceof JcsError) return null;
    throw e;
  }
}

async function resolveSafely(req: ValidRequest, ctx: FactSourceContext): Promise<unknown> {
  try {
    return await req.source.resolve(ctx, req.path, req.args);
  } catch (err) {
    // 来源函数失败（如业务角色查库失败）只让该 claim 不签，不阻断登记；日志不带取值
    console.error('[fact-signer] source resolve failed', { source: req.source.id, path: req.path, err });
    return undefined;
  }
}

/**
 * claim 值与 action 线上值比对。principal.id / principal.roles 等类型化字段无需另查 claim_type_mismatch：
 * claim 与 action 值 JCS 相等，而 action 的这些字段由 toGuardAction 按类型构造。
 */
function checkClaim(wireAction: unknown, path: string, value: unknown): SkipReason | null {
  if (isAmbiguous(wireAction, path)) return 'ambiguous_path';
  const actual = valueAtPath(wireAction, path);
  if (!actual.found) return 'value_mismatch';
  const claimed = canonicalOrNull(value);
  return claimed !== null && claimed === canonicalOrNull(actual.value) ? null : 'value_mismatch';
}

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 由来源函数取值 → 与 action 比对 → 至多签一条事实。请求不合规抛 {@link FactSignerError}（400）。 */
export async function signFacts(input: SignFactsInput): Promise<SignFactsResult> {
  const requests = validateAll(input.requests, input.sources);
  // aster-api 比对的是请求体原文树：先按线上形态序列化再解析，undefined 键等 JSON 之外的差异与之对齐
  const wireAction: unknown = JSON.parse(JSON.stringify(input.action));
  const claims: Record<string, unknown> = {};
  const sources: Record<string, string> = {};
  const skipped: SignFactsResult['skipped'] = [];
  for (const req of requests) {
    const value = await resolveSafely(req, input.ctx);
    const reason = value === undefined ? 'unresolved' : checkClaim(wireAction, req.path, value);
    if (reason) {
      skipped.push({ path: req.path, reason });
      continue;
    }
    claims[req.path] = value;
    sources[req.path] = req.source.id;
  }
  if (Object.keys(claims).length === 0) return { fact: null, skipped };

  const payload = {
    alg: 'Ed25519' as const,
    audience: input.ctx.tenantId,
    claims,
    expiresAt: new Date(input.now.getTime() + FACT_TTL_MS).toISOString(),
    issuedAt: input.now.toISOString(),
    issuer: input.key.issuer,
    kid: input.key.kid,
    sources,
  };
  const bytes = new TextEncoder().encode(jcsCanonicalize(payload));
  const signature = await crypto.subtle.sign({ name: 'Ed25519' }, input.key.privateKey, bytes);
  return { fact: { ...payload, signature: base64url(signature) }, skipped };
}
