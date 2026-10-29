// ADR 0051 §9 存量重编译（cloud 侧）：真实 Postgres 上验证逐行状态机、词汇段回填、旧封印完整性前置校验、
// 版本哈希链维护与分诊报告。aster-api 编译调用被替换为按源码决定结果的桩，不访问网络。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts resolver-migration

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { asc, eq, like, sql } from 'drizzle-orm';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/cache', () => ({ invalidatePolicyCache: vi.fn(async () => undefined) }));
vi.mock('@/lib/metrics/aha-detection', () => ({ recordAhaMomentIfFirst: vi.fn(async () => false) }));

type Outcome =
  | { kind: 'ok' }
  | { kind: 'diagnostics'; code: string; message?: string }
  | { kind: 'unavailable' }
  /** 上游 HTTP 拒绝；diagnostics 给出时为编译资源的源码/别名输入错误形态。 */
  | { kind: 'http'; status: number; code: string; diagnostics?: unknown[] }
  /** 编译挂起直到 release：让迁移事务持有行锁，制造并发窗口。 */
  | { kind: 'gate'; released: Promise<void> };

const compileState = vi.hoisted(() => ({
  outcomes: new Map<string, unknown>(),
  calls: [] as Array<{ tenantId: string; userId: string; request: Record<string, unknown> }>,
}));

vi.mock('@/services/policy/policy-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/policy/policy-api')>();
  return {
    ...actual,
    createPolicyApiClient: (tenantId: string, userId: string) => ({
      compile: async (request: Record<string, unknown>) => {
        compileState.calls.push({ tenantId, userId, request });
        const outcome = (compileState.outcomes.get(request.source as string) ?? { kind: 'ok' }) as Outcome;
        if (outcome.kind === 'gate') await outcome.released;
        if (outcome.kind === 'http') {
          const details = outcome.diagnostics ? { code: outcome.code, diagnostics: outcome.diagnostics } : { code: outcome.code };
          throw new actual.PolicyApiError(`HTTP ${outcome.status}`, outcome.status, outcome.code, undefined, details);
        }
        if (outcome.kind === 'unavailable') {
          throw new actual.PolicyApiError('Service Unavailable', 503, 'UNAVAILABLE');
        }
        if (outcome.kind === 'diagnostics') {
          return {
            success: false,
            diagnostics: [{
              severity: 'error', code: outcome.code, message: outcome.message ?? `${outcome.code} failure`,
              startLine: 1, startColumn: 1, endLine: 1, endColumn: 2,
            }],
          };
        }
        return { success: true, diagnostics: [] };
      },
    }),
  };
});

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
import { approveVersion, createVersion } from '@/services/policy/version-manager';
import { cloudToolchainId, computeSourceEnvelope, vocabularyScopesJson } from '@/lib/policy-alias';
import { recordedCompileLocale } from '@/lib/policy-version-locale';
import { computeChainedHash } from '@/services/security/policy-security';
import { loadLiveVocabularyForPolicy, loadVocabularyForExecution } from '@/lib/domain-vocabulary-snapshot';
import {
  INTEGRITY_MISMATCH_ERROR,
  migrateVersion,
  runResolverMigration,
  type ResolverMigrationReport,
} from '@/services/policy/resolver-migration';

const PREFIX = 'pol-resolver-mig-it-';
const USER = 'user-resolver-mig-it';
const BAD_VOCAB_USER = 'user-resolver-mig-it-bad';
const OLD_TOOLCHAIN = 'abi=1.0;core=ts;validator=1;build=old';
const DE_SOURCE = `Modul e2e1027.vocab.

Definiere Fahrer hat alter als Ganzzahl.

Regel bewerten gegeben person als Fahrer liefert Ganzzahl:
  wenn person.alter mindestens 18:
    gib zurück 42.
  gib zurück 0.
`;

type Db = ReturnType<typeof createDb>;
type Row = typeof policyVersions.$inferSelect;
type Status = Row['status'];
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

/** 迁移前的 4 段 envelope，独立实现（不复用被测代码），钉住旧封印格式。 */
function legacyEnvelope(content: string, aliasSet: string | null, locale: string, toolchain: string): string {
  const hash = createHash('sha256');
  for (const field of [content, aliasSet, locale, toolchain]) {
    const bytes = Buffer.from(field ?? '', 'utf8');
    hash.update(`${bytes.length}:`, 'ascii');
    hash.update(bytes);
    hash.update('|', 'ascii');
  }
  return hash.digest('hex');
}

interface Spec {
  source: string;
  status?: Status;
  /** false = ADR 0022 之前没有 envelope 的旧行。 */
  envelope?: boolean;
  locale?: string;
  createdBy?: string | null;
  aliasSet?: string | null;
}

/** 按迁移前的规则造一条链：prevHash = 前驱 envelope ?? sourceHash，sourceHash = H(source + prevHash)。 */
function legacyRows(policyId: string, specs: Spec[]) {
  let prev: { envelope: string | null; sourceHash: string } | null = null;
  return specs.map((spec, i) => {
    const prevHash = prev ? (prev.envelope ?? prev.sourceHash) : null;
    const sourceHash = computeChainedHash(spec.source, prevHash);
    const aliasSet = spec.aliasSet ?? null;
    const envelope = spec.envelope === false
      ? null
      : legacyEnvelope(spec.source, aliasSet, spec.locale ?? 'en-US', OLD_TOOLCHAIN);
    prev = { envelope, sourceHash };
    return {
      id: `${policyId}-v${i + 1}`,
      policyId,
      version: i + 1,
      content: spec.source,
      source: spec.source,
      status: spec.status ?? 'APPROVED',
      createdBy: spec.createdBy === undefined ? USER : spec.createdBy,
      aliasSet,
      sourceHash,
      prevHash,
      sourceEnvelopeSha256: envelope,
      sourceToolchainId: envelope ? OLD_TOOLCHAIN : null,
    } satisfies typeof policyVersions.$inferInsert;
  });
}

async function seed(db: Db, policyId: string, specs: Spec[], owner = USER): Promise<void> {
  await db.insert(policies).values({
    id: policyId, userId: owner, name: policyId, content: specs.at(-1)!.source, version: specs.length,
    updatedAt: new Date(),
  } as typeof policies.$inferInsert);
  await db.insert(policyVersions).values(legacyRows(policyId, specs));
}

async function rowsOf(db: Db, policyId: string): Promise<Row[]> {
  return db.select().from(policyVersions).where(eq(policyVersions.policyId, policyId)).orderBy(asc(policyVersions.version));
}

/** 链有效：每个后继的 prevHash 等于前驱链接，且 sourceHash 与 (source, prevHash) 自洽。 */
function expectChainValid(rows: Row[]): void {
  rows.forEach((row, i) => {
    const prev = rows[i - 1];
    expect(row.prevHash).toBe(prev ? (prev.sourceEnvelopeSha256 ?? prev.sourceHash) : null);
    expect(row.sourceHash).toBe(computeChainedHash(row.source ?? row.content, row.prevHash));
  });
}

function localeView(row: Row) {
  return { ...row, source: row.source ?? row.content };
}

function newEnvelope(row: Row, locale: string, scopesJson: string): string {
  return computeSourceEnvelope(row.source ?? row.content, row.aliasSet, locale, cloudToolchainId(), scopesJson);
}

function src(name: string): string {
  return `Module resolver.mig.\n\nRule ${name} given x as Int, produce Int:\n  Return x.\n`;
}

function fail(source: string, code: string, message?: string): void {
  compileState.outcomes.set(source, { kind: 'diagnostics', code, message });
}

async function run(policyId: string, batchSize = 50): Promise<ResolverMigrationReport> {
  return runResolverMigration({ batchSize, policyIdPrefix: policyId });
}

function term(id: string, kind: string, canonical: string, localized: string, parent: string | null) {
  return {
    id: `dt-resolver-mig-it-${id}`,
    domain: 'e2e1027',
    locale: 'de',
    kind,
    canonical,
    canonicalNorm: canonical.toLowerCase(),
    localized,
    localizedNorm: localized,
    parentCanonical: parent,
    source: 'user',
    dedupKey: `resolver-mig-it-${id}`,
  } as typeof domainTerms.$inferInsert;
}

function link(user: string, id: string, kind: string) {
  return { id: `udt-resolver-mig-it-${user}-${id}`, userId: user, termId: `dt-resolver-mig-it-${id}`, domain: 'e2e1027', locale: 'de', kind };
}

async function cleanup(db: Db): Promise<void> {
  await db.delete(policyApprovals).where(like(policyApprovals.versionId, `${PREFIX}%`));
  await db.delete(securityEvents).where(like(securityEvents.policyId, `${PREFIX}%`));
  await db.delete(policyVersions).where(like(policyVersions.policyId, `${PREFIX}%`));
  await db.delete(policies).where(like(policies.id, `${PREFIX}%`));
  await db.delete(userVocabularySnapshots).where(sql`${userVocabularySnapshots.ownerId} IN (${USER}, ${BAD_VOCAB_USER})`);
  await db.delete(userDomainTerms).where(sql`${userDomainTerms.userId} IN (${USER}, ${BAD_VOCAB_USER})`);
  await db.delete(domainTerms).where(like(domainTerms.id, 'dt-resolver-mig-it-%'));
  await db.delete(users).where(sql`${users.id} IN (${USER}, ${BAD_VOCAB_USER})`);
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('resolver 迁移（ADR 0051 §9，cloud）', () => {
  const previous = globalForDb.__asterLocalDevDb;
  const db = createDb(undefined, { max: 6 });

  beforeAll(async () => {
    globalForDb.__asterLocalDevDb = db;
    await cleanup(db);
    await db.insert(users).values([USER, BAD_VOCAB_USER].map((id) => ({
      id, email: `${id}@example.test`, updatedAt: new Date(),
    })) as Array<typeof users.$inferInsert>);
    await db.insert(domainTerms).values([
      term('driver', 'struct', 'Driver', 'Fahrer', null),
      term('age', 'field', 'age', 'alter', 'Driver'),
      // 缺 parent 的字段：作者词汇无法构成作用域（引擎 VocabularyScopeError）
      term('orphan', 'field', 'age', 'alter', null),
    ]);
    await db.insert(userDomainTerms).values([
      link(USER, 'driver', 'struct'),
      link(USER, 'age', 'field'),
      link(BAD_VOCAB_USER, 'driver', 'struct'),
      link(BAD_VOCAB_USER, 'orphan', 'field'),
    ]);
  });

  beforeEach(() => {
    compileState.outcomes.clear();
    compileState.calls.length = 0;
  });

  afterAll(async () => {
    await cleanup(db);
    globalForDb.__asterLocalDevDb = previous;
    await db.$client.end({ timeout: 1 });
  });

  it('全量成功（跨批）：当前工具链 5 段 envelope、词汇段回填、resolverVersion=1、链有效', async () => {
    const policyId = `${PREFIX}all`;
    await seed(db, policyId, [
      { source: src('a1') },
      { source: src('a2'), aliasSet: '{"if":["falls"]}' },
      { source: src('a3'), status: 'DRAFT' },
    ]);

    const report = await run(policyId, 2);

    expect(report).toMatchObject({ processed: 3, succeeded: 3, failed: 0, failures: [] });
    const rows = await rowsOf(db, policyId);
    for (const row of rows) {
      expect(row.resolverVersion).toBe(1);
      expect(row.resolverMigrationError).toBeNull();
      expect(row.sourceToolchainId).toBe(cloudToolchainId());
      expect(row.sourceScopesJson).toBe('');
      expect(row.sourceEnvelopeSha256).toBe(newEnvelope(row, 'en-US', ''));
      expect(recordedCompileLocale(localeView(row))).toBe('en-US');
    }
    expect(rows.map((r) => r.status)).toEqual(['APPROVED', 'APPROVED', 'DRAFT']);
    expectChainValid(rows);
    // 冻结别名照常交给编译，结构词授权视为冻结时已定
    expect(compileState.calls[1]!.request).toMatchObject({ aliasSet: { if: ['falls'] }, locale: 'en-US' });
    expect(compileState.calls.every((c) => c.tenantId === USER)).toBe(true);
  });

  it('词汇段回填：已审批版本取冻结快照，草稿取作者现行词汇；编译带同一份词汇', async () => {
    const policyId = `${PREFIX}vocab`;
    await seed(db, policyId, [
      { source: DE_SOURCE, status: 'PENDING_APPROVAL', locale: 'de-DE' },
      { source: DE_SOURCE, status: 'DRAFT', locale: 'de-DE' },
    ]);
    await approveVersion({ policyId, version: 1, approverId: USER, decision: 'APPROVED' });
    // 审批冻结之后作者改了词条：草稿应看到新同义词，已审批版本不应看到
    await db.update(domainTerms).set({ aliases: ['lebensalter'] }).where(eq(domainTerms.id, 'dt-resolver-mig-it-age'));
    const [approved] = await rowsOf(db, policyId);
    const ctx = { source: DE_SOURCE, locale: 'de-DE' };
    const frozen = vocabularyScopesJson(await loadVocabularyForExecution(approved!.vocabularySnapshotIds, ctx));
    const live = vocabularyScopesJson(await loadLiveVocabularyForPolicy(USER, ctx));
    expect(frozen).not.toBe('');
    expect(live).not.toBe(frozen);

    const report = await run(policyId);

    expect(report).toMatchObject({ processed: 2, succeeded: 2, failed: 0 });
    const [v1, v2] = await rowsOf(db, policyId);
    expect(v1!.sourceScopesJson).toBe(frozen);
    expect(v2!.sourceScopesJson).toBe(live);
    expect(v1!.sourceEnvelopeSha256).toBe(newEnvelope(v1!, 'de-DE', frozen));
    expect(v2!.sourceEnvelopeSha256).toBe(newEnvelope(v2!, 'de-DE', live));
    expect(recordedCompileLocale(localeView(v2!))).toBe('de-DE');
    expect(vocabularyScopesJson(compileState.calls[0]!.request.vocabulary as never)).toBe(frozen);
    expect(vocabularyScopesJson(compileState.calls[1]!.request.vocabulary as never)).toBe(live);
    expect(compileState.calls[0]!.request.locale).toBe('de-DE');
    expectChainValid([v1!, v2!]);
    await db.update(domainTerms).set({ aliases: [] }).where(eq(domainTerms.id, 'dt-resolver-mig-it-age'));
  });

  it('本任务归档的已审批版本重试时仍按归档前状态取冻结快照', async () => {
    const policyId = `${PREFIX}vocab-retry`;
    await seed(db, policyId, [{ source: DE_SOURCE, status: 'PENDING_APPROVAL', locale: 'de-DE' }]);
    await approveVersion({ policyId, version: 1, approverId: USER, decision: 'APPROVED' });
    await db.update(domainTerms).set({ aliases: ['lebensalter'] }).where(eq(domainTerms.id, 'dt-resolver-mig-it-age'));
    const [approved] = await rowsOf(db, policyId);
    const frozen = vocabularyScopesJson(
      await loadVocabularyForExecution(approved!.vocabularySnapshotIds, { source: DE_SOURCE, locale: 'de-DE' }),
    );
    fail(DE_SOURCE, 'E802');
    await run(policyId);
    expect((await rowsOf(db, policyId))[0]).toMatchObject({ status: 'ARCHIVED', statusBeforeArchive: 'APPROVED' });

    compileState.outcomes.clear();
    await run(policyId);

    const [v1] = await rowsOf(db, policyId);
    expect(v1).toMatchObject({ status: 'APPROVED', resolverVersion: 1, sourceScopesJson: frozen });
    await db.update(domainTerms).set({ aliases: [] }).where(eq(domainTerms.id, 'dt-resolver-mig-it-age'));
  });

  it('中间行失败：归档并记标记与原状态，旧 envelope / 工具链 / 词汇段不动，链仍有效', async () => {
    const policyId = `${PREFIX}fail`;
    await seed(db, policyId, [{ source: src('f1') }, { source: src('f2') }, { source: src('f3'), status: 'DEPRECATED' }]);
    const before = await rowsOf(db, policyId);
    fail(src('f2'), 'E802', "Cannot resolve name 'kunde' in VALUE_REF position");

    const report = await run(policyId);

    expect(report).toMatchObject({ processed: 3, succeeded: 2, failed: 1 });
    expect(report.failures[0]).toMatchObject({ id: `${policyId}-v2`, category: 'compile', codes: ['E802'] });
    const [v1, v2, v3] = await rowsOf(db, policyId);
    expect(v2).toMatchObject({
      status: 'ARCHIVED',
      archivedByResolverMigration: true,
      statusBeforeArchive: 'APPROVED',
      resolverVersion: null,
      sourceEnvelopeSha256: before[1]!.sourceEnvelopeSha256,
      sourceToolchainId: OLD_TOOLCHAIN,
      sourceScopesJson: null,
      prevHash: v1!.sourceEnvelopeSha256,
    });
    expect(v2!.resolverMigrationError).toContain('E802');
    expect(v3).toMatchObject({ status: 'DEPRECATED', resolverVersion: 1 });
    expectChainValid([v1!, v2!, v3!]);
    // 失败行保留 4 段旧封印，旧格式仍能反推编译 locale
    expect(recordedCompileLocale(localeView(v2!))).toBe('en-US');
  });

  it('重跑跳过成功行、重试失败行；修好后恢复原状态并清标记；再跑无事可做', async () => {
    const policyId = `${PREFIX}rerun`;
    await seed(db, policyId, [{ source: src('r1') }, { source: src('r2') }]);
    fail(src('r2'), 'E804');
    await run(policyId);
    const afterFirst = await rowsOf(db, policyId);

    const second = await run(policyId);
    expect(second).toMatchObject({ processed: 1, succeeded: 0, failed: 1 });
    const afterSecond = await rowsOf(db, policyId);
    expect(afterSecond[0]).toEqual(afterFirst[0]);
    expect(afterSecond[1]).toMatchObject({ status: 'ARCHIVED', statusBeforeArchive: 'APPROVED', archivedByResolverMigration: true });

    compileState.outcomes.clear();
    const third = await run(policyId);
    expect(third).toMatchObject({ processed: 1, succeeded: 1, failed: 0 });
    const [v1, v2] = await rowsOf(db, policyId);
    expect(v2).toMatchObject({
      status: 'APPROVED', archivedByResolverMigration: false, statusBeforeArchive: null,
      resolverVersion: 1, resolverMigrationError: null,
    });
    expectChainValid([v1!, v2!]);

    expect(await run(policyId)).toMatchObject({ processed: 0, succeeded: 0, failed: 0 });
  });

  it('人工归档行：失败只记错误不动标记，成功也不恢复状态', async () => {
    const policyId = `${PREFIX}manual`;
    await seed(db, policyId, [{ source: src('m1'), status: 'ARCHIVED' }, { source: src('m2'), status: 'ARCHIVED' }]);
    fail(src('m1'), 'E800');

    await run(policyId);

    const [v1, v2] = await rowsOf(db, policyId);
    expect(v1).toMatchObject({ status: 'ARCHIVED', archivedByResolverMigration: false, statusBeforeArchive: null, resolverVersion: null });
    expect(v1!.resolverMigrationError).toContain('E800');
    expect(v2).toMatchObject({ status: 'ARCHIVED', archivedByResolverMigration: false, statusBeforeArchive: null, resolverVersion: 1 });
  });

  it('中断后重跑收敛：先逐行迁移前两行再分批跑两遍，与一次跑完的结果逐字段相同', async () => {
    const specs: Spec[] = [
      { source: src('i1') }, { source: src('i2') }, { source: src('i3') }, { source: src('i4'), status: 'DRAFT' },
    ];
    const whole = `${PREFIX}int-a`;
    const resumed = `${PREFIX}int-b`;
    await seed(db, whole, specs);
    await seed(db, resumed, specs);
    fail(src('i3'), 'E802');

    await run(whole);
    await migrateVersion(`${resumed}-v1`);
    await migrateVersion(`${resumed}-v2`);
    await run(resumed, 1);
    await run(resumed, 3);

    const strip = (rows: Row[]) => rows.map(({ id: _id, policyId: _p, createdAt: _c, ...rest }) => rest);
    const a = await rowsOf(db, whole);
    const b = await rowsOf(db, resumed);
    // 第二遍会重试失败行，错误内容相同
    expect(strip(b)).toEqual(strip(a));
    expectChainValid(a);
    expectChainValid(b);
  });

  it('旧封印不符：报 integrity mismatch，不封印、不改状态、不改链', async () => {
    const policyId = `${PREFIX}tamper`;
    await seed(db, policyId, [{ source: src('t1') }, { source: src('t2') }]);
    await db.update(policyVersions).set({ source: `${src('t1')}  -- tampered` }).where(eq(policyVersions.id, `${policyId}-v1`));
    const before = await rowsOf(db, policyId);

    const report = await run(policyId);

    expect(report.failures).toContainEqual(expect.objectContaining({
      id: `${policyId}-v1`, category: 'integrity', error: INTEGRITY_MISMATCH_ERROR,
    }));
    const [v1, v2] = await rowsOf(db, policyId);
    expect(v1).toEqual({ ...before[0]!, resolverMigrationError: INTEGRITY_MISMATCH_ERROR });
    expect(v2!.prevHash).toBe(before[1]!.prevHash);
    expect(v2!.resolverVersion).toBe(1);
  });

  it('有 envelope 但缺工具链串：按不符处理', async () => {
    const policyId = `${PREFIX}notc`;
    await seed(db, policyId, [{ source: src('n1') }]);
    await db.update(policyVersions).set({ sourceToolchainId: null }).where(eq(policyVersions.policyId, policyId));

    const report = await run(policyId);

    expect(report.failures).toEqual([expect.objectContaining({ category: 'integrity', error: INTEGRITY_MISMATCH_ERROR })]);
    expect((await rowsOf(db, policyId))[0]).toMatchObject({ status: 'APPROVED', resolverVersion: null, sourceEnvelopeSha256: expect.any(String) });
  });

  it('无 envelope 的旧行按 sourceHash 校验：相符则迁移并改写后继链接，不符则不封印', async () => {
    const ok = `${PREFIX}pre-ok`;
    const bad = `${PREFIX}pre-bad`;
    // 两行都没有 envelope：v1 的链接从 sourceHash 换成新 envelope，v2 的 prevHash / sourceHash 随之改写
    await seed(db, ok, [{ source: src('p1'), envelope: false }, { source: src('p2'), envelope: false }, { source: src('p3') }]);
    await seed(db, bad, [{ source: src('q1'), envelope: false }]);
    await db.update(policyVersions).set({ sourceHash: 'sha256:deadbeef' }).where(eq(policyVersions.policyId, bad));

    const okReport = await run(ok);
    const badReport = await run(bad);

    expect(okReport).toMatchObject({ processed: 3, succeeded: 3 });
    const rows = await rowsOf(db, ok);
    expect(rows.every((r) => r.resolverVersion === 1 && r.sourceEnvelopeSha256 !== null)).toBe(true);
    expectChainValid(rows);
    expect(badReport.failures).toEqual([expect.objectContaining({ category: 'integrity' })]);
    expect((await rowsOf(db, bad))[0]).toMatchObject({ sourceEnvelopeSha256: null, resolverVersion: null, status: 'APPROVED' });
  });

  it('迁移前已断的链保持断开（改写按旧链接比较后才写）', async () => {
    const policyId = `${PREFIX}broken`;
    await seed(db, policyId, [{ source: src('b1') }, { source: src('b2') }]);
    await db.update(policyVersions).set({ prevHash: 'broken-link' }).where(eq(policyVersions.id, `${policyId}-v2`));

    await run(policyId);

    const [, v2] = await rowsOf(db, policyId);
    expect(v2!.prevHash).toBe('broken-link');
  });

  it('迁移链尾期间新建版本：createVersion 等迁移提交后接在新链接上', async () => {
    const policyId = `${PREFIX}tail-lock`;
    await seed(db, policyId, [{ source: src('l1') }, { source: src('l2') }]);
    let release!: () => void;
    compileState.outcomes.set(src('l2'), { kind: 'gate', released: new Promise<void>((r) => { release = r; }) });

    const migrating = migrateVersion(`${policyId}-v2`);
    await vi.waitFor(() => expect(compileState.calls).toHaveLength(1));
    let created = false;
    const creating = createVersion({ policyId, source: src('l3'), createdBy: USER, locale: 'en-US', scopesJson: '' })
      .then((r) => { created = true; return r; });
    await new Promise((r) => setTimeout(r, 700));
    // 迁移事务仍持有链尾行锁：新建版本必须等待
    expect(created).toBe(false);

    release();
    expect(await migrating).toMatchObject({ status: 'SUCCEEDED' });
    const result = await creating;

    const rows = await rowsOf(db, policyId);
    expect(result.version).toBe(3);
    expect(rows[1]!.resolverVersion).toBe(1);
    expect(rows[2]!.prevHash).toBe(rows[1]!.sourceEnvelopeSha256);
    expectChainValid(rows);
  });

  it('基础设施故障（编译服务 503）：不归档、不改动，下次重跑再试', async () => {
    const policyId = `${PREFIX}infra`;
    await seed(db, policyId, [{ source: src('x1') }]);
    compileState.outcomes.set(src('x1'), { kind: 'unavailable' });
    const before = await rowsOf(db, policyId);

    const report = await run(policyId);

    expect(report.failures).toEqual([expect.objectContaining({ category: 'infrastructure' })]);
    expect(await rowsOf(db, policyId)).toEqual(before);
    compileState.outcomes.clear();
    expect(await run(policyId)).toMatchObject({ succeeded: 1 });
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'internal_only'],
    [404, 'not_found'],
  ])('不带编译诊断的上游 %i（签名/租户/地址错误）：按基础设施处理，不归档、不改动', async (status, code) => {
    const policyId = `${PREFIX}http-${status}`;
    await seed(db, policyId, [{ source: src(`h${status}a`) }, { source: src(`h${status}b`), status: 'DRAFT' }]);
    for (const name of [`h${status}a`, `h${status}b`]) {
      compileState.outcomes.set(src(name), { kind: 'http', status, code });
    }
    const before = await rowsOf(db, policyId);

    const report = await run(policyId);

    expect(report).toMatchObject({ processed: 2, succeeded: 0, failed: 2 });
    expect(report.triage.infrastructure).toEqual([
      expect.objectContaining({ id: `${policyId}-v1`, policyId, version: 1, ownerId: USER, category: 'infrastructure' }),
      expect.objectContaining({ id: `${policyId}-v2`, policyId, version: 2, ownerId: USER }),
    ]);
    expect(await rowsOf(db, policyId)).toEqual(before);
  });

  it('带编译诊断的 4xx（源码/别名输入错误）仍按名称解析失败归档', async () => {
    const policyId = `${PREFIX}http-diag`;
    await seed(db, policyId, [{ source: src('hd') }]);
    compileState.outcomes.set(src('hd'), {
      kind: 'http', status: 400, code: 'compile_error',
      diagnostics: [{ severity: 'error', code: 'E802', message: "Cannot resolve name 'x'", startLine: 1, startColumn: 1 }],
    });

    const report = await run(policyId);

    expect(report.failures).toEqual([expect.objectContaining({ category: 'compile', codes: ['E802'] })]);
    expect((await rowsOf(db, policyId))[0]).toMatchObject({ status: 'ARCHIVED', archivedByResolverMigration: true });
  });

  // #649：4xx 但只带 api 内部故障码 = 编译没做成，与 200 success:false 分支同口径，按基础设施故障不归档
  it('只有 COMPILE_INTERNAL_ERROR 诊断的 4xx 不归档：行保持待迁移，列入 infrastructure', async () => {
    const policyId = `${PREFIX}http-internal`;
    await seed(db, policyId, [{ source: src('hi') }]);
    compileState.outcomes.set(src('hi'), {
      kind: 'http', status: 400, code: 'COMPILE_FAILED',
      diagnostics: [{ severity: 'error', code: 'COMPILE_INTERNAL_ERROR', message: 'internal failure' }],
    });
    const before = await rowsOf(db, policyId);

    const report = await run(policyId);

    expect(report).toMatchObject({ processed: 1, succeeded: 0, failed: 1 });
    expect(report.triage.infrastructure).toEqual([
      expect.objectContaining({ id: `${policyId}-v1`, category: 'infrastructure' }),
    ]);
    expect(await rowsOf(db, policyId)).toEqual(before);
  });

  it('分诊报告：E8xx、无效构造写法、E801、作者词汇非法（按用户）、完整性不符分组列出', async () => {
    const e8 = `${PREFIX}tri-e8`;
    const construct = `${PREFIX}tri-construct`;
    const e801 = `${PREFIX}tri-e801`;
    const vocab = `${PREFIX}tri-vocab`;
    const integrity = `${PREFIX}tri-integrity`;
    const constructSource = `Modul m.\n\nRegel r gegeben x als Ganzzahl, liefert Fahrer:\n  gib zurück Fahrer mit alter = x.\n`;
    await seed(db, e8, [{ source: src('e8') }]);
    await seed(db, construct, [{ source: constructSource, locale: 'de-DE' }]);
    await seed(db, e801, [{ source: src('e801') }]);
    await seed(db, vocab, [{ source: DE_SOURCE, status: 'DRAFT', locale: 'de-DE', createdBy: BAD_VOCAB_USER }], BAD_VOCAB_USER);
    await seed(db, integrity, [{ source: src('ti') }]);
    await db.update(policyVersions).set({ aliasSet: '{"if":["wenn"]}' }).where(eq(policyVersions.policyId, integrity));
    fail(src('e8'), 'E802');
    fail(constructSource, 'P005', "Unexpected token '='");
    fail(src('e801'), 'E801', "Cannot resolve field 'alter' in FIELD_REF position");

    const report = await runResolverMigration({ batchSize: 50, policyIdPrefix: `${PREFIX}tri-` });

    expect(report).toMatchObject({ processed: 5, succeeded: 0, failed: 5 });
    const ids = (list: Array<{ id: string }>) => list.map((f) => f.id);
    expect(ids(report.triage.e8xx)).toEqual([`${e8}-v1`]);
    expect(ids(report.triage.invalidConstructForm)).toEqual([`${construct}-v1`]);
    expect(ids(report.triage.untypedFieldAccess)).toEqual([`${e801}-v1`]);
    expect(report.triage.vocabularyScopeByUser).toEqual({
      [BAD_VOCAB_USER]: [expect.objectContaining({ id: `${vocab}-v1`, reason: 'field_parent_required', term: 'alter', kind: 'field' })],
    });
    expect(ids(report.triage.integrityMismatch)).toEqual([`${integrity}-v1`]);
    expect(report.triage.infrastructure).toEqual([]);
    // 作者词汇非法属于名称解析失败：归档，修好词条后重跑可恢复
    expect((await rowsOf(db, vocab))[0]).toMatchObject({ status: 'ARCHIVED', archivedByResolverMigration: true, statusBeforeArchive: 'DRAFT' });
    expect((await rowsOf(db, vocab))[0]!.resolverMigrationError).toContain('field_parent_required');
  });
});
