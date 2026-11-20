// 孤儿决策上下文的执行链接（ADR 0061 §3.5）：按 metadata.guardDecisionId 查最新执行，且其策略租户 = 本租户，
// 真实 Postgres。他租户策略下带同一 guardDecisionId 的执行绝不返回。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts guard-reconciliation-execution-link

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { inArray } from 'drizzle-orm';

vi.mock('server-only', () => ({}));

import { createDb } from '@/db';
import { executions, policies, users } from '@/lib/prisma';
import { findExecutionForDecision } from '@/lib/guard-reconciliation/decision-context';

const OWNER_A = 'it-recon-owner-a';
const OWNER_B = 'it-recon-owner-b';
const TEAM = 'it-recon-team';
const POLICY_TEAM = 'it-recon-p-team';
const POLICY_A = 'it-recon-p-a';
const POLICY_B = 'it-recon-p-b';
const DECISION = '6f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b';
const OTHER_DECISION = '7f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5c';
const EXEC_IDS = ['it-recon-e1', 'it-recon-e2', 'it-recon-e3', 'it-recon-e4', 'it-recon-e5'];

type Db = ReturnType<typeof createDb>;
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

describe.skipIf(process.env.LICENSE_E2E !== '1')('findExecutionForDecision（真实 Postgres）', () => {
  const previous = globalForDb.__asterLocalDevDb;
  const db = createDb(undefined, { max: 2 });

  async function cleanup(): Promise<void> {
    await db.delete(executions).where(inArray(executions.id, EXEC_IDS));
    await db.delete(policies).where(inArray(policies.id, [POLICY_TEAM, POLICY_A, POLICY_B]));
  }

  function exec(id: string, policyId: string, decisionId: string, createdAt: string, userId = OWNER_A) {
    return {
      id, userId, policyId, input: {}, durationMs: 1, success: true,
      metadata: { guardDecisionId: decisionId }, createdAt: new Date(createdAt),
    } as typeof executions.$inferInsert;
  }

  beforeAll(async () => {
    globalForDb.__asterLocalDevDb = db;
    await cleanup();
    await db.delete(users).where(inArray(users.id, [OWNER_A, OWNER_B]));
    await db.insert(users).values([OWNER_A, OWNER_B].map((id) => ({ id, email: `${id}@example.test`, updatedAt: new Date() })) as
      Array<typeof users.$inferInsert>);
  });

  beforeEach(async () => {
    await cleanup();
    const now = new Date();
    await db.insert(policies).values([
      { id: POLICY_TEAM, userId: OWNER_A, teamId: TEAM, name: POLICY_TEAM, content: 'x', updatedAt: now },
      { id: POLICY_A, userId: OWNER_A, teamId: '', name: POLICY_A, content: 'x', updatedAt: now },
      { id: POLICY_B, userId: OWNER_B, teamId: null, name: POLICY_B, content: 'x', updatedAt: now },
    ]);
  });

  afterAll(async () => {
    await cleanup();
    await db.delete(users).where(inArray(users.id, [OWNER_A, OWNER_B]));
    globalForDb.__asterLocalDevDb = previous;
    await db.$client.end({ timeout: 1 });
  });

  it('同一 guardDecisionId 的两条执行分属本租户与他租户 → 只返回本租户那条', async () => {
    await db.insert(executions).values([
      exec('it-recon-e1', POLICY_A, DECISION, '2026-11-20T01:00:00Z'),
      exec('it-recon-e2', POLICY_B, DECISION, '2026-11-20T02:00:00Z', OWNER_B),
    ]);
    expect(await findExecutionForDecision(OWNER_A, DECISION)).toEqual({ policyId: POLICY_A, executionId: 'it-recon-e1' });
    expect(await findExecutionForDecision(OWNER_B, DECISION)).toEqual({ policyId: POLICY_B, executionId: 'it-recon-e2' });
    expect(await findExecutionForDecision('someone-else', DECISION)).toBeNull();
  });

  it('团队策略按 teamId 归属（不按策略所有者）；空串 teamId 视同个人策略', async () => {
    await db.insert(executions).values([exec('it-recon-e3', POLICY_TEAM, DECISION, '2026-11-20T01:00:00Z')]);
    expect(await findExecutionForDecision(TEAM, DECISION)).toEqual({ policyId: POLICY_TEAM, executionId: 'it-recon-e3' });
    expect(await findExecutionForDecision(OWNER_A, DECISION)).toBeNull();
  });

  it('多条本租户执行取最新；无匹配 → null', async () => {
    await db.insert(executions).values([
      exec('it-recon-e4', POLICY_A, DECISION, '2026-11-20T01:00:00Z'),
      exec('it-recon-e5', POLICY_A, DECISION, '2026-11-20T03:00:00Z'),
    ]);
    expect(await findExecutionForDecision(OWNER_A, DECISION)).toEqual({ policyId: POLICY_A, executionId: 'it-recon-e5' });
    expect(await findExecutionForDecision(OWNER_A, OTHER_DECISION)).toBeNull();
  });
});
