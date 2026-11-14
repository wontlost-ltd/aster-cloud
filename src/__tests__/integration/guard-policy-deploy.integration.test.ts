// Guard 策略部署（aster-api ADR 0054 §11 D1，R66）：先部署后提交、代际、cron 收敛与回填，真实 Postgres。
// aster-api 调用以 setGuardDeployDepsForTest 替换为记录器；载荷构造用真实实现（源码、入口函数、Module 头、sha256）。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts guard-policy-deploy

import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';

vi.mock('server-only', () => ({}));

import { createDb } from '@/db';
import { guardPolicyDeployments, policies, policyRecycleBins, policyVersions, users } from '@/lib/prisma';
import {
  backfillGuardDeployments,
  deployThenCommit,
  GuardDeployError,
  reconcileGuardDeployments,
  reserveGuardGeneration,
  pushGuardDeployment,
  setGuardDeployDepsForTest,
} from '@/lib/guard-policy-deploy';
import { restorePolicy, softDeletePolicy } from '@/lib/policy-lifecycle';
import { PolicyApiError, type GuardPolicyDeploymentBody } from '@/services/policy/policy-api';
import { setDefaultVersion } from '@/services/policy/version-manager';

const OWNER = 'it-guard-deploy-owner';
const POLICY = 'it-guard-deploy-p1';
const SOURCE_V1 = 'Module it.guard.deploy.\n\nRule decide given amount as Int, produce Bool:\n  Return amount > 100.\n';
const SOURCE_V2 = 'Module it.guard.deploy.\n\nRule decide given amount as Int, produce Bool:\n  Return amount > 200.\n';

type Db = ReturnType<typeof createDb>;
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

interface Call {
  kind: 'deploy' | 'withdraw';
  tenantId: string;
  actor: string;
  policyId: string;
  generation: number;
  body?: GuardPolicyDeploymentBody;
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('Guard 策略部署（真实 Postgres）', () => {
  const previous = globalForDb.__asterLocalDevDb;
  const db = createDb(undefined, { max: 4 });
  let calls: Call[] = [];
  let failNext: PolicyApiError | undefined;

  function recorder(onDeploy?: () => Promise<void>) {
    return {
      async deploy(tenantId: string, actor: string, policyId: string, body: GuardPolicyDeploymentBody) {
        calls.push({ kind: 'deploy', tenantId, actor, policyId, generation: body.generation, body });
        await onDeploy?.();
        if (failNext) {
          const e = failNext;
          failNext = undefined;
          throw e;
        }
        return { policyVersionId: 1000 + body.generation };
      },
      async withdraw(tenantId: string, actor: string, policyId: string, generation: number) {
        calls.push({ kind: 'withdraw', tenantId, actor, policyId, generation });
        if (failNext) {
          const e = failNext;
          failNext = undefined;
          throw e;
        }
      },
    };
  }

  async function cleanup(): Promise<void> {
    await db.delete(guardPolicyDeployments).where(eq(guardPolicyDeployments.policyId, POLICY));
    await db.delete(policyRecycleBins).where(eq(policyRecycleBins.policyId, POLICY));
    await db.delete(policyVersions).where(eq(policyVersions.policyId, POLICY));
    await db.delete(policies).where(eq(policies.id, POLICY));
  }

  async function seed(defaultVersion: 1 | 2 | null): Promise<void> {
    await db.insert(policies).values({ id: POLICY, userId: OWNER, name: POLICY, content: SOURCE_V1, updatedAt: new Date() });
    await db.insert(policyVersions).values(
      [SOURCE_V1, SOURCE_V2].map((content, i) => ({
        id: `${POLICY}-v${i + 1}`,
        policyId: POLICY,
        version: i + 1,
        content,
        status: 'APPROVED' as const,
        createdBy: OWNER,
        isDefault: defaultVersion === i + 1,
        locale: 'en-US',
      })) as Array<typeof policyVersions.$inferInsert>,
    );
  }

  async function defaultVersionId(): Promise<string | undefined> {
    const row = await db.query.policyVersions.findFirst({
      where: and(eq(policyVersions.policyId, POLICY), eq(policyVersions.isDefault, true)),
    });
    return row?.id;
  }

  async function state() {
    return db.query.guardPolicyDeployments.findFirst({ where: eq(guardPolicyDeployments.policyId, POLICY) });
  }

  beforeAll(async () => {
    globalForDb.__asterLocalDevDb = db;
    await cleanup();
    await db.delete(users).where(inArray(users.id, [OWNER]));
    await db.insert(users).values({ id: OWNER, email: `${OWNER}@example.test`, updatedAt: new Date() } as typeof users.$inferInsert);
  });

  beforeEach(async () => {
    await cleanup();
    calls = [];
    failNext = undefined;
    setGuardDeployDepsForTest(recorder());
  });

  afterEach(() => setGuardDeployDepsForTest(undefined));

  afterAll(async () => {
    await cleanup();
    await db.delete(users).where(eq(users.id, OWNER));
    globalForDb.__asterLocalDevDb = previous;
    await db.$client.end({ timeout: 1 });
  });

  it('setDefaultTriggersDeploy：载荷含源码、入口函数、Module 头、sha256；成功后才切默认版本', async () => {
    await seed(1);
    await setDefaultVersion({ policyId: POLICY, version: 2, userId: OWNER });
    expect(calls).toHaveLength(1);
    const { body, tenantId, actor, generation } = calls[0];
    expect({ tenantId, actor, generation }).toEqual({ tenantId: OWNER, actor: OWNER, generation: 1 });
    expect(body).toMatchObject({
      cloudVersionId: `${POLICY}-v2`,
      cloudVersion: 2,
      moduleName: 'it.guard.deploy',
      functionName: 'decide',
      source: SOURCE_V2,
      locale: 'en-US',
      sourceSha256: createHash('sha256').update(SOURCE_V2, 'utf8').digest('hex'),
    });
    expect(await defaultVersionId()).toBe(`${POLICY}-v2`);
    expect(await state()).toMatchObject({ generation: 1, appliedGeneration: 1, desiredVersionId: `${POLICY}-v2`, lastError: null });
  });

  it('deployFailureBlocksDefaultChange：aster-api 503 / 422 → 抛 GuardDeployError，默认版本不变，记 lastError', async () => {
    await seed(1);
    failNext = new PolicyApiError('down', 503, 'service_unavailable');
    await expect(setDefaultVersion({ policyId: POLICY, version: 2, userId: OWNER })).rejects.toMatchObject({
      status: 503,
      error: 'guard_deploy_unavailable',
    });
    expect(await defaultVersionId()).toBe(`${POLICY}-v1`);
    expect((await state())?.lastError).toContain('503');
    failNext = new PolicyApiError('bad', 422, 'compile_failed');
    await expect(setDefaultVersion({ policyId: POLICY, version: 2, userId: OWNER })).rejects.toMatchObject({
      status: 422,
      error: 'compile_failed',
    });
    expect(await defaultVersionId()).toBe(`${POLICY}-v1`);
  });

  it('policyDeleteTriggersWithdraw；withdrawFailureBlocksDelete；从未部署的策略删除不依赖 aster-api', async () => {
    await seed(1);
    await setDefaultVersion({ policyId: POLICY, version: 2, userId: OWNER });
    failNext = new PolicyApiError('down', 503, 'service_unavailable');
    const blocked = await softDeletePolicy(POLICY, OWNER);
    expect(blocked).toMatchObject({ success: false, status: 503 });
    expect((await db.query.policies.findFirst({ where: eq(policies.id, POLICY) }))?.deletedAt).toBeNull();
    const ok = await softDeletePolicy(POLICY, OWNER);
    expect(ok.success).toBe(true);
    expect(calls.map((c) => c.kind)).toEqual(['deploy', 'withdraw', 'withdraw']);
    expect(await state()).toMatchObject({ desiredVersionId: null });

    await cleanup();
    calls = [];
    await seed(1);
    failNext = new PolicyApiError('down', 503, 'service_unavailable');
    expect((await softDeletePolicy(POLICY, OWNER)).success).toBe(true);
    expect(calls).toEqual([]);
  });

  it('concurrentFirstReservationsGetDistinctGenerations（原子预留，不撞主键）', async () => {
    await seed(1);
    const gens = await Promise.all(
      Array.from({ length: 5 }, () => reserveGuardGeneration(POLICY, OWNER, { cloudVersionId: `${POLICY}-v1` })),
    );
    expect([...gens].sort()).toEqual([1, 2, 3, 4, 5]);
    expect((await state())?.generation).toBe(5);
  });

  it('deleteFencesFirstDeploy：从未部署的删除先提交后，并发的首次设默认不会部署（404 policy_deleted）', async () => {
    await seed(1);
    expect((await softDeletePolicy(POLICY, OWNER)).success).toBe(true);
    await expect(
      reserveGuardGeneration(POLICY, OWNER, { cloudVersionId: `${POLICY}-v2` }),
    ).rejects.toMatchObject({ status: 404, error: 'policy_deleted' });
    expect(calls).toEqual([]);
    expect(await state()).toBeUndefined();
  });

  it('deleteAfterConcurrentReservationWithdraws：锁内看到部署行 → 走撤回路径', async () => {
    await seed(1);
    await reserveGuardGeneration(POLICY, OWNER, { cloudVersionId: `${POLICY}-v2` });
    expect((await softDeletePolicy(POLICY, OWNER)).success).toBe(true);
    expect(calls.map((c) => c.kind)).toEqual(['withdraw']);
    expect(await state()).toMatchObject({ generation: 2, desiredVersionId: null, appliedGeneration: 2 });
  });

  it('restoreRedeploysDefault：从未部署的策略删除后恢复 → 部署其默认版本，之后由 cron 跟踪', async () => {
    await seed(2);
    expect((await softDeletePolicy(POLICY, OWNER)).success).toBe(true);
    expect(calls).toEqual([]);
    expect((await restorePolicy(POLICY, OWNER)).success).toBe(true);
    expect(calls.map((c) => [c.kind, c.body?.cloudVersionId])).toEqual([['deploy', `${POLICY}-v2`]]);
    expect(await state()).toMatchObject({ desiredVersionId: `${POLICY}-v2`, appliedGeneration: 1 });
  });

  it('staleGenerationTreatedAsSuperseded', async () => {
    await seed(1);
    const generation = await reserveGuardGeneration(POLICY, OWNER, { cloudVersionId: `${POLICY}-v1` });
    failNext = new PolicyApiError('stale', 409, 'stale_generation');
    expect(await pushGuardDeployment(POLICY, generation, OWNER)).toEqual({ ok: true, superseded: true });
    expect((await state())?.appliedGeneration).toBeNull();
  });

  it('reversedCompletionOlderCommitIsRefused：A 预留并部署后暂停，B 完成，A 再提交 → 409', async () => {
    await seed(1);
    let nested = false;
    setGuardDeployDepsForTest(
      recorder(async () => {
        if (nested) return;
        nested = true;
        // A 的部署进行中，B 完整跑完（预留 gen 2、部署、提交 v1 为默认）。
        await deployThenCommit({
          policyId: POLICY,
          tenantId: OWNER,
          desired: { cloudVersionId: `${POLICY}-v1` },
          actor: OWNER,
          commit: async (tx) => {
            await tx.update(policyVersions).set({ isDefault: false }).where(eq(policyVersions.policyId, POLICY));
            await tx.update(policyVersions).set({ isDefault: true }).where(eq(policyVersions.id, `${POLICY}-v1`));
          },
        });
      }),
    );
    const a = setDefaultVersion({ policyId: POLICY, version: 2, userId: OWNER });
    await expect(a).rejects.toBeInstanceOf(GuardDeployError);
    await expect(a).rejects.toMatchObject({ status: 409, error: 'default_changed_concurrently' });
    expect(await defaultVersionId()).toBe(`${POLICY}-v1`);
    expect((await state())?.generation).toBe(2);
  });

  it('cronReconcilesAfterCommitFailure：aster-api 已切到 v2 而 cloud 默认仍是 v1 → 以 generation+1 重发 v1', async () => {
    await seed(1);
    const g = await reserveGuardGeneration(POLICY, OWNER, { cloudVersionId: `${POLICY}-v2` });
    expect((await pushGuardDeployment(POLICY, g, OWNER)).ok).toBe(true);
    calls = [];
    const report = await reconcileGuardDeployments();
    expect(report.failed).toEqual([]);
    const mine = calls.filter((c) => c.policyId === POLICY);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: 'deploy', generation: g + 1, actor: 'system:guard-deploy-sync' });
    expect(mine[0].body?.cloudVersionId).toBe(`${POLICY}-v1`);
    calls = [];
    await reconcileGuardDeployments();
    expect(calls.filter((c) => c.policyId === POLICY)).toEqual([]);
  });

  it('backfillDeploysEveryPolicyWithDefaultApprovedVersion：dry-run 只列出，--apply 才调用', async () => {
    await seed(2);
    const dry = await backfillGuardDeployments({ apply: false });
    expect(dry.filter((r) => r.policyId === POLICY)).toEqual([{ policyId: POLICY, versionId: `${POLICY}-v2`, result: 'dry-run' }]);
    expect(calls).toEqual([]);
    const applied = await backfillGuardDeployments({ apply: true });
    expect(applied.find((r) => r.policyId === POLICY)?.result).toMatchObject({ ok: true });
    expect(calls.filter((c) => c.policyId === POLICY)).toHaveLength(1);
    expect((await backfillGuardDeployments({ apply: false })).filter((r) => r.policyId === POLICY)).toEqual([]);
  });
});
