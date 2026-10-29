// #650：新增词条的冲突预览只报告「这条预览词条带来的」问题（真实 Postgres）。
// 此前把整组现有词条 + 预览词条一起校验并返回全部错误：ADR 0051 前入库的无关旧错误被当成该词条的冲突；
// 且只取一页（200 条），分组超过一页时漏掉后面的冲突。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts domain-vocabulary-preview

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, domainTerms, userDomainTerms, users } from '@/lib/prisma';
import { setupTestDb, teardownTestDb } from './setup-postgres';

vi.mock('@/lib/usage', () => ({
  getLexiconQuota: vi.fn().mockResolvedValue({ maxTerms: 5000, bulkAsync: true, allowed: true }),
}));
vi.mock('@/lib/audit-log', () => ({ logAuditEvent: vi.fn().mockResolvedValue(undefined) }));

import { previewAddTerm, type TermInput } from '@/lib/domain-vocabulary';

const USER = 'vocab-preview-it-user';
let domain = 'insurance.preview';

/** 直接落库一条词条（绕过服务层校验，模拟 ADR 0051 前入库的旧数据）。 */
async function seedTerm(key: string, kind: string, canonical: string, localized: string, parent: string | null = null) {
  const termId = `dt-${domain}-${key}`;
  await db.insert(domainTerms).values({
    id: termId, domain, locale: 'de', kind, canonical, canonicalNorm: canonical.toLowerCase(),
    localized, localizedNorm: localized.toLowerCase(), parentCanonical: parent, source: 'user',
    dedupKey: `preview-it-${domain}-${key}`,
  } as typeof domainTerms.$inferInsert);
  await db.insert(userDomainTerms).values({
    id: `udt-${domain}-${key}`, userId: USER, termId, ownerType: 'user', domain, locale: 'de', kind,
  });
}

const struct = (canonical: string, localized: string): TermInput => ({ domain, locale: 'de', kind: 'struct', canonical, localized });

describe.skipIf(process.env.LICENSE_E2E !== '1')('新增词条冲突预览（#650）', () => {
  beforeAll(async () => {
    await setupTestDb();
  }, 120_000);

  afterAll(async () => {
    await db.delete(users).where(eq(users.id, USER));
    await teardownTestDb();
  });

  beforeEach(async () => {
    domain = `insurance.p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await db.delete(users).where(eq(users.id, USER));
    await db.insert(users).values({ id: USER, updatedAt: new Date() } as typeof users.$inferInsert);
  });

  it('分组里已有无关旧错误（字段缺 parent）：无冲突的预览词条不报告它', async () => {
    await seedTerm('orphan', 'field', 'age', 'alter');
    const preview = await previewAddTerm(USER, struct('Car', 'Auto'));
    expect(preview.collisions).toEqual([]);
  });

  it('预览词条与已有词条同写法：只报告这条冲突', async () => {
    await seedTerm('orphan', 'field', 'age', 'alter');
    await seedTerm('car', 'struct', 'Car', 'Auto');
    const preview = await previewAddTerm(USER, struct('Vehicle', 'Auto'));
    expect(preview.collisions).toHaveLength(1);
    expect(preview.collisions[0]).toContain('"Auto"');
    expect(preview.collisions.join('\n')).not.toContain('"alter"');
  });

  it('分组超过一页（>200 条）时，后面的词条同样参与冲突判定', async () => {
    for (let i = 0; i < 205; i++) await seedTerm(`s${i}`, 'struct', `S${i}`, `Wort${i}`);
    // 列表按 createdAt 倒序分页：把要撞的那条设成最早，确保它落在第一页之外
    await db.update(userDomainTerms).set({ createdAt: new Date('2000-01-01T00:00:00Z') })
      .where(eq(userDomainTerms.id, `udt-${domain}-s0`));
    const preview = await previewAddTerm(USER, struct('Other', 'Wort0'));
    expect(preview.collisions).toHaveLength(1);
    expect(preview.collisions[0]).toContain('"Wort0"');
  });
});
