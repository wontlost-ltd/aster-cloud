/**
 * 本地栈浏览器 E2E 公共辅助：storageState 路径、生产防护、psql 查询。
 * 仅服务于 local-stack 目录下的用例，不得被生产冒烟用例引用。
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

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
