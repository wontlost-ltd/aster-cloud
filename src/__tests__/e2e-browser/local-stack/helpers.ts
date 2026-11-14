/**
 * 本地栈浏览器 E2E 公共辅助：storageState 路径、生产防护、psql 查询。
 * 仅服务于 local-stack 目录下的用例，不得被生产冒烟用例引用。
 */
import { execFileSync } from 'node:child_process';
import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { join } from 'node:path';
import { jcsCanonicalize } from '@/lib/jcs';

// 只在 BASE_CLOUD 指向 localhost 时运行，杜绝误打生产
export const NOT_LOCAL = !process.env.BASE_CLOUD?.includes('localhost');
export const NOT_LOCAL_REASON = '仅针对本地 aster-cloud 栈（BASE_CLOUD 需包含 localhost）';

// 会话夹具目录，由 scripts/e2e-local-session.ts 在容器内生成
const STATE_DIR = process.env.E2E_STATE_DIR || join(process.cwd(), '.superpowers/e2e-local');

export function stateFor(user: 'm-free' | 'm-dpo' | 'owner1' | 't1' | 'cp-owner' | 'cp-officer' | 'cp-analyst'): string {
  return join(STATE_DIR, `state-${user}.json`);
}

const PODMAN = process.env.PODMAN_BIN || '/opt/podman/bin/podman';

/** 在 aster-pg 容器里执行只读/校验用 SQL，返回去空白的单行文本结果。 */
export function psql(db: 'aster_cloud' | 'aster_policy', sql: string): string {
  return execFileSync(PODMAN, ['exec', 'aster-pg', 'psql', '-U', 'postgres', '-d', db, '-Atc', sql], {
    encoding: 'utf8',
  }).trim();
}

// aster-api 根地址（guard 决策端点所在），默认本地栈端口
export const BASE_API = process.env.BASE_API || 'http://localhost:8080';

/**
 * 经 aster-api 的 guard 决策端点为请求方 key 所属租户补一条新的待审批，返回 decisionId。
 * 请求与 aster-guard `scripts/e2e-local.mjs` 第 2 步相同（guard.customer/decide 的 delete_customer_record
 * 需 Data Protection Officer 审批）；principal 以 `e2e-` 开头，便于与种子数据区分。
 */
export async function seedPendingGuardApproval(apiKey: string): Promise<string> {
  const res = await fetch(`${BASE_API}/api/v1/guard/decisions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({
      policyModule: 'guard.customer',
      policyFunction: 'decide',
      action: {
        principal: { id: `e2e-${randomUUID()}`, type: 'agent' },
        action: { name: 'delete_customer_record' },
        resource: { type: 'customer', id: 'C-E2E-1' },
      },
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { decisionId?: string; effectiveOutcome?: string };
  if (!res.ok || body.effectiveOutcome !== 'PENDING' || !body.decisionId) {
    throw new Error(`补待审批失败：HTTP ${res.status} ${JSON.stringify(body)}`);
  }
  return body.decisionId;
}

// aster-cloud 根地址（v1 执行端点所在），即被测栈
export const BASE_CLOUD = process.env.BASE_CLOUD || 'http://localhost:3100';

/**
 * 经 aster-cloud 的 v1 执行端点执行 pol-adr0041-team（delete_customer_record，需 DPO 审批），
 * 返回这条执行在日志里关联的 guard decisionId。
 *
 * <p>★执行日志页列的是 **aster-cloud 的执行记录**；只走 aster-api guard 端点补的决策没有对应执行行，
 * 日志页永远不会出现它。故日志用例必须经 cloud 执行补数据。cloud 响应不回传 decisionId，
 * 以唯一 principal_id 从 `Execution.metadata.guardDecisionId` 取回。
 */
export async function seedPendingCloudExecution(apiKey: string): Promise<string> {
  const principal = `e2e-${randomUUID()}`;
  const res = await fetch(`${BASE_CLOUD}/api/v1/policies/pol-adr0041-team/execute`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: {
        req: {
          principal_id: principal, principal_type: 'agent', principal_roles: [],
          action: 'delete_customer_record', resource_type: 'customer', resource_id: 'C-E2E-1',
          context: {}, agent_model: '',
        },
      },
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: { metadata?: { outcome?: string } } };
  if (body.data?.metadata?.outcome !== 'REQUIRE_APPROVAL') {
    throw new Error(`补待审批执行失败：HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  }
  const decisionId = psql('aster_cloud',
    `select metadata->>'guardDecisionId' from "Execution" where "policyId"='pol-adr0041-team' `
    + `and input->'req'->>'principal_id'='${principal}' order by "createdAt" desc limit 1`);
  if (!/^[0-9a-f-]{36}$/.test(decisionId)) {
    throw new Error(`执行已记录但未关联 guard decisionId：${JSON.stringify(decisionId)}`);
  }
  return decisionId;
}

/** aster-api 端点的 Bearer 调用（guard / audit）；返回状态码与原文体（体可能为空，例如 404）。 */
export async function apiCall(
  method: 'GET' | 'POST',
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<{ status: number; text: string; json: Record<string, unknown> | null }> {
  const res = await fetch(`${BASE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

export const apiGet = (path: string, apiKey: string) => apiCall('GET', path, apiKey);
export const apiPost = (path: string, apiKey: string, body: unknown) => apiCall('POST', path, apiKey, body);

/** aster-api 签发的执行收据（ADR 0040 §12 D1）。 */
export interface ExecutionReceipt {
  kid: string;
  payload: {
    actionHash: string;
    decisionId: string;
    expiresAt: string;
    issuedAt: string;
    kid: string;
    outcome: string;
    policyVersionId?: number;
    tenantId: string;
    v: number;
  };
  revision?: number;
  signature: string;
}

/** JWKS 中的一把 OKP 公钥（RFC 8037）。 */
export interface OkpJwk {
  kid?: string;
  kty?: string;
  crv?: string;
  x?: string;
}

export type ReceiptVerdict =
  | 'ok'
  | 'kid_unknown'
  | 'bad_signature'
  | 'tenant_mismatch'
  | 'decision_mismatch'
  | 'not_allow'
  | 'not_yet_valid'
  | 'expired';

/**
 * 执行方本地验签（ADR 0040 §12 D6 顺序）：kid ∈ JWKS → Ed25519 作用于 payload 的 JCS 字节串 →
 * tenantId / decisionId / outcome → 时间窗 {@code issuedAt − 60s <= now < expiresAt}。
 * 与 aster-api 绕过套件的参考执行方（`io.aster.guard.bypass.ReferenceExecutor`）同一顺序；actionHash 由调用方另行比对。
 */
export function verifyExecutionReceipt(
  receipt: ExecutionReceipt,
  jwks: { keys: OkpJwk[] },
  expected: { tenantId: string; decisionId: string; now: Date },
): ReceiptVerdict {
  const jwk = jwks.keys.find((k) => k.kid === receipt.kid && k.kty === 'OKP' && k.crv === 'Ed25519');
  if (!jwk || receipt.payload.kid !== receipt.kid) return 'kid_unknown';
  let valid = false;
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' });
    const signature = Buffer.from(receipt.signature, 'base64url');
    valid = signature.length === 64
      && verify(null, Buffer.from(jcsCanonicalize(receipt.payload), 'utf8'), key, signature);
  } catch {
    valid = false;
  }
  if (!valid) return 'bad_signature';
  const p = receipt.payload;
  if (p.tenantId !== expected.tenantId) return 'tenant_mismatch';
  if (p.decisionId !== expected.decisionId) return 'decision_mismatch';
  if (p.outcome !== 'ALLOW' || p.v !== 1) return 'not_allow';
  const now = expected.now.getTime();
  if (now < Date.parse(p.issuedAt) - 60_000) return 'not_yet_valid';
  if (now >= Date.parse(p.expiresAt)) return 'expired';
  return 'ok';
}
