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
const BASE_API = process.env.BASE_API || 'http://localhost:8080';

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
