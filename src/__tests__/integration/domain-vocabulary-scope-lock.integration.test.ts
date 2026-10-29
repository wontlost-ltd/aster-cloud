// #650：修改 / 恢复词条的作用域冲突校验必须与新增在同一把用户级 advisory lock 内（真实 Postgres）。
// 此前 modify / restore 在锁外校验：并发的新增（持锁、未提交）对它们不可见，各自通过后
// 同一分组里出现「同一写法对应两个规范名」的冲突词条。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts domain-vocabulary-scope-lock

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, domainTerms, userDomainTerms, users } from '@/lib/prisma';
import { setupTestDb, teardownTestDb } from './setup-postgres';

vi.mock('@/lib/usage', () => ({
  getLexiconQuota: vi.fn().mockResolvedValue({ maxTerms: 5000, bulkAsync: true, allowed: true }),
}));
vi.mock('@/lib/audit-log', () => ({ logAuditEvent: vi.fn().mockResolvedValue(undefined) }));

import {
  addUserVocabularyTerm,
  lockUserVocabularyWrites,
  modifyUserVocabularyTerm,
  restoreUserVocabularyTerm,
  softDeleteUserVocabularyTerm,
  type TermInput,
} from '@/lib/domain-vocabulary';

const USER = 'vocab-scope-lock-it-user';
let domain = 'insurance.lock';

const struct = (canonical: string, localized: string): TermInput => ({
  domain, locale: 'de', kind: 'struct', canonical, localized,
});

/** 在持有用户锁、尚未提交的事务里插入一条 Vehicle → "Wagen" 词条，release 后提交。 */
function holdLockWithPendingWagen() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let ready!: () => void;
  const locked = new Promise<void>((resolve) => { ready = resolve; });
  const done = db.transaction(async (tx) => {
    await lockUserVocabularyWrites(tx, USER);
    const termId = `dt-${domain}-vehicle`;
    await tx.insert(domainTerms).values({
      id: termId, domain, locale: 'de', kind: 'struct',
      canonical: 'Vehicle', canonicalNorm: 'vehicle', localized: 'Wagen', localizedNorm: 'wagen',
      parentCanonical: null, source: 'user', dedupKey: `scope-lock-it-${domain}-vehicle`,
    } as typeof domainTerms.$inferInsert);
    await tx.insert(userDomainTerms).values({
      id: `udt-${domain}-vehicle`, userId: USER, termId, ownerType: 'user', domain, locale: 'de', kind: 'struct',
    });
    ready();
    await released;
  });
  return { locked, release, done };
}

/**
 * 等到被测调用在某把锁上排队（pg_locks 出现未授予的锁：修复后是用户 advisory lock，修复前是词汇版本行）
 * 或已经结束，再放行持锁事务。不用固定延时：冷启动时被测调用可能晚于延时才走到校验，那样测不出锁外校验。
 */
async function blockedOnLockOrSettled(settled: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !settled()) {
    const [row] = await db.execute<{ waiting: number }>(
      sql`SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted`,
    );
    if ((row?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function activeLocalized(): Promise<string[]> {
  const rows = await db
    .select({ localized: domainTerms.localized })
    .from(userDomainTerms)
    .innerJoin(domainTerms, eq(domainTerms.id, userDomainTerms.termId))
    .where(and(eq(userDomainTerms.userId, USER), isNull(userDomainTerms.deletedAt)));
  return rows.map((r) => r.localized).sort();
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('词条修改 / 恢复的作用域校验在用户锁内（#650）', () => {
  beforeAll(async () => {
    await setupTestDb();
  }, 120_000);

  afterAll(async () => {
    await db.delete(users).where(eq(users.id, USER));
    await teardownTestDb();
  });

  beforeEach(async () => {
    domain = `insurance.l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await db.delete(users).where(eq(users.id, USER));
    await db.insert(users).values({ id: USER, updatedAt: new Date() } as typeof users.$inferInsert);
  });

  it('修改：等待并发新增提交后再校验，同写法冲突被拒绝', async () => {
    const { link } = await addUserVocabularyTerm(USER, struct('Car', 'Auto'));
    const holder = holdLockWithPendingWagen();
    await holder.locked;

    const modify = modifyUserVocabularyTerm(USER, link.id, struct('Car', 'Wagen'));
    let settled = false;
    const outcome = modify.then(() => 'ok', (err: { code?: string }) => err.code).finally(() => { settled = true; });
    await blockedOnLockOrSettled(() => settled);
    holder.release();
    await holder.done;

    expect(await outcome).toBe('validation_failed');
    expect(await activeLocalized()).toEqual(['Auto', 'Wagen']);
  });

  it('恢复：等待并发新增提交后再校验，同写法冲突被拒绝且仍保持删除', async () => {
    const { link } = await addUserVocabularyTerm(USER, struct('Car', 'Wagen'));
    await softDeleteUserVocabularyTerm(USER, link.id);
    const holder = holdLockWithPendingWagen();
    await holder.locked;

    const restore = restoreUserVocabularyTerm(USER, link.id);
    let settled = false;
    const outcome = restore.then(() => 'ok', (err: { code?: string }) => err.code).finally(() => { settled = true; });
    await blockedOnLockOrSettled(() => settled);
    holder.release();
    await holder.done;

    expect(await outcome).toBe('validation_failed');
    expect(await activeLocalized()).toEqual(['Wagen']);
  });

  it('无冲突时修改与恢复照常成功', async () => {
    const { link } = await addUserVocabularyTerm(USER, struct('Car', 'Auto'));
    await modifyUserVocabularyTerm(USER, link.id, struct('Car', 'Kfz'));
    await softDeleteUserVocabularyTerm(USER, link.id);
    await restoreUserVocabularyTerm(USER, link.id);
    expect(await activeLocalized()).toEqual(['Kfz']);
  });
});
