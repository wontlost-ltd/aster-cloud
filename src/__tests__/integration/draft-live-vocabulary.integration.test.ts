// #626 选项 A（真实 Postgres，外部 DATABASE_URL）：草稿按作者现行词汇执行，编辑词条后立即生效；
// 已审批版本只用审批时冻结的快照，不受之后的词条编辑影响。词汇加载与输入映射走生产代码路径。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts draft-live-vocabulary

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/cache', () => ({ invalidatePolicyCache: vi.fn(async () => undefined) }));
vi.mock('@/lib/metrics/aha-detection', () => ({ recordAhaMomentIfFirst: vi.fn(async () => false) }));

import { createDb } from '@/db';
import {
  domainTerms,
  policies,
  policyApprovals,
  policyVersions,
  securityEvents,
  userDomainTerms,
  users,
  userVocabularySnapshots,
} from '@/lib/prisma';
import { approveVersion } from '@/services/policy/version-manager';
import { loadVersionExecutionVocabulary, prepareExecutionInput } from '@/lib/execution-input';

const USER = 'user-draft-live-vocab-it';
const POLICY = 'pol-draft-live-vocab-it';
const SOURCE = `Modul e2e1027.vocab.

Definiere Fahrer hat alter als Ganzzahl.

Regel bewerten gegeben person als Fahrer liefert Ganzzahl:
  wenn person.alter mindestens 18:
    gib zurück 42.
  gib zurück 0.
`;

type Db = ReturnType<typeof createDb>;
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

async function cleanup(db: Db): Promise<void> {
  await db.delete(policyApprovals).where(sql`${policyApprovals.versionId} LIKE ${`${POLICY}%`}`);
  await db.delete(securityEvents).where(eq(securityEvents.policyId, POLICY));
  await db.delete(policyVersions).where(eq(policyVersions.policyId, POLICY));
  await db.delete(policies).where(eq(policies.id, POLICY));
  await db.delete(userVocabularySnapshots).where(eq(userVocabularySnapshots.ownerId, USER));
  await db.delete(userDomainTerms).where(eq(userDomainTerms.userId, USER));
  await db.delete(domainTerms).where(sql`${domainTerms.id} LIKE 'dt-draft-live-it-%'`);
  await db.delete(users).where(eq(users.id, USER));
}

function term(id: string, kind: string, canonical: string, localized: string, parentCanonical: string | null) {
  return {
    id: `dt-draft-live-it-${id}`,
    domain: 'e2e1027',
    locale: 'de',
    kind,
    canonical,
    canonicalNorm: canonical.toLowerCase(),
    localized,
    localizedNorm: localized.toLowerCase(),
    parentCanonical,
    source: 'user',
    dedupKey: `draft-live-it-${id}`,
  } as typeof domainTerms.$inferInsert;
}

async function versionRow(db: Db, version: number) {
  const [row] = await db
    .select({ status: policyVersions.status, refs: policyVersions.vocabularySnapshotIds, createdBy: policyVersions.createdBy })
    .from(policyVersions)
    .where(eq(policyVersions.id, `${POLICY}-v${version}`));
  return row!;
}

/** 与执行路由同一流程：按版本状态取词汇，再映射输入。 */
async function mapForVersion(version: number, input: unknown) {
  const row = await versionRow(globalForDb.__asterLocalDevDb!, version);
  const vocabulary = await loadVersionExecutionVocabulary({
    status: row.status,
    vocabularySnapshotIds: row.refs,
    authorId: row.createdBy,
    source: SOURCE,
    locale: 'de-DE',
  });
  return prepareExecutionInput({ input, functionName: undefined, vocabulary, source: SOURCE, locale: 'de-DE', aliasSet: null });
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('草稿按作者现行词汇执行（#626）', () => {
  const previous = globalForDb.__asterLocalDevDb;
  const db = createDb(undefined, { max: 4 });

  beforeAll(async () => {
    globalForDb.__asterLocalDevDb = db;
    await cleanup(db);
    await db.insert(users).values({ id: USER, email: `${USER}@example.test`, updatedAt: new Date() } as typeof users.$inferInsert);
    await db.insert(domainTerms).values([
      term('driver', 'struct', 'Driver', 'Fahrer', null),
      term('age', 'field', 'age', 'alter', 'Driver'),
    ]);
    await db.insert(userDomainTerms).values(
      ['driver', 'age'].map((id) => ({
        id: `udt-draft-live-it-${id}`,
        userId: USER,
        termId: `dt-draft-live-it-${id}`,
        domain: 'e2e1027',
        locale: 'de',
        kind: id === 'driver' ? 'struct' : 'field',
      })),
    );
    await db.insert(policies).values({
      id: POLICY, userId: USER, name: 'draft-live-vocab-it', content: SOURCE, version: 2, updatedAt: new Date(),
    } as typeof policies.$inferInsert);
    await db.insert(policyVersions).values([1, 2].map((version) => ({
      id: `${POLICY}-v${version}`, policyId: POLICY, version, content: SOURCE, source: SOURCE,
      status: version === 1 ? 'PENDING_APPROVAL' as const : 'DRAFT' as const, createdBy: USER,
    })));
    await approveVersion({ policyId: POLICY, version: 1, approverId: USER, decision: 'APPROVED' });
  });

  afterAll(async () => {
    await cleanup(db);
    globalForDb.__asterLocalDevDb = previous;
    await db.$client.end({ timeout: 1 });
  });

  it('草稿：本地化输入用作者现行词汇映射为规范名；已审批版本同样可用（冻结快照）', async () => {
    expect(await mapForVersion(2, { person: { alter: 21 } })).toMatchObject({ ok: true, input: { person: { age: 21 } } });
    expect(await mapForVersion(1, { person: { alter: 21 } })).toMatchObject({ ok: true, input: { person: { age: 21 } } });
  });

  it('编辑词条（给 age 加同义词 lebensalter）后草稿立即生效，已审批版本不受影响', async () => {
    await db.update(domainTerms)
      .set({ aliases: ['lebensalter'] })
      .where(eq(domainTerms.id, 'dt-draft-live-it-age'));

    expect(await mapForVersion(2, { person: { lebensalter: 21 } })).toMatchObject({ ok: true, input: { person: { age: 21 } } });
    // 冻结快照里没有这个同义词：原样透传（与修复前对未知键的行为一致）。
    expect(await mapForVersion(1, { person: { lebensalter: 21 } })).toMatchObject({ ok: true, input: { person: { lebensalter: 21 } } });
  });

  it('草稿里两个同义词并存 → 歧义', async () => {
    const result = await mapForVersion(2, { person: { alter: 1, lebensalter: 2 } });
    expect(result).toMatchObject({ ok: false, ambiguous: { field: 'person.lebensalter', fields: ['person.alter', 'person.lebensalter'], policyName: 'alter' } });
  });
});
