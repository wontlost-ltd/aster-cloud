// 需求验证（产品分析事件 + 试点申请）真库集成测试。
//
// 只有真库能验的：dedupeKey 唯一索引让 once 事件在并发 / 多实例下只落一行；PilotUseCase enum 数组
// 列的读写；管理端汇总 SQL（周计数、模板分布、漏斗、落地页、来源、Guard 按租户）在真 Postgres 上的结果。
//
// Run: LICENSE_E2E=1 DATABASE_URL=<已迁移到最新的库> pnpm exec vitest run --config vitest.integration.config.ts demand-validation
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db, productEvents, pilotApplications, apiCallRecords, users } from '@/lib/prisma';
import {
  pseudonymize,
  purgeExpiredProductEvents,
  recordProductEvent,
  resetOnceCacheForTests,
} from '@/lib/product-events/server';
import { loadDemandReport } from '@/lib/product-events/report';
import {
  deletePilotApplication,
  hasRecentPilotApplication,
  insertPilotApplication,
  purgeExpiredPilotApplications,
  listPilotApplications,
  parsePilotApplication,
  pilotApplicationsToCsv,
} from '@/lib/pilot-applications';
import { setupTestDb, teardownTestDb } from './setup-postgres';

const NOW = new Date();

async function guardCall(tenantId: string, endpointPath = '/api/v1/guard/decisions', status = 'success') {
  await db.insert(apiCallRecords).values({
    id: crypto.randomUUID(), userId: 'u-api', tenantId, periodMonth: '2026-11', endpointPath, status,
  });
}

const FUNNEL_USERS = ['dv-a', 'dv-b', 'dv-c'];

describe.skipIf(process.env.LICENSE_E2E !== '1')('需求验证：事件、汇总与试点申请（真库）', () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await db.delete(productEvents);
    await db.delete(pilotApplications);
    await db.delete(apiCallRecords);
    await db.delete(users).where(inArray(users.id, FUNNEL_USERS));
    resetOnceCacheForTests();
  });

  it('once 事件：并发重复只落一行（dedupeKey 唯一索引），普通事件不去重', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => recordProductEvent('policy_first_executed', { userId: 'u1', properties: { source: 'api' } })),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    resetOnceCacheForTests();
    expect(await recordProductEvent('policy_first_executed', { userId: 'u1' })).toBe(false);

    await recordProductEvent('evidence_exported', { userId: 'u1', properties: { format: 'json' } });
    await recordProductEvent('evidence_exported', { userId: 'u1', properties: { format: 'json' } });
    const rows = await db.select().from(productEvents);
    expect(rows.filter((r) => r.name === 'policy_first_executed')).toHaveLength(1);
    expect(rows.filter((r) => r.name === 'evidence_exported')).toHaveLength(2);
    expect(rows.every((r) => r.actorId === pseudonymize('user', 'u1'))).toBe(true);
  });

  it('汇总：周计数含 Guard 成功调用，模板分布、已验证漏斗、落地页、来源、Guard 按租户', async () => {
    // 3 人注册：a、b 已验证邮箱，c 未验证（不进漏斗分母）。a、b、c 都首存；a 首跑并导出。
    await db.insert(users).values([
      { id: 'dv-a', email: 'dv-a@example.test', emailVerified: new Date(), updatedAt: new Date() },
      { id: 'dv-b', email: 'dv-b@example.test', emailVerified: new Date(), updatedAt: new Date() },
      { id: 'dv-c', email: 'dv-c@example.test', emailVerified: null, updatedAt: new Date() },
    ] as Array<typeof users.$inferInsert>);
    for (const u of FUNNEL_USERS) await recordProductEvent('signup_completed', { userId: u, tenantId: u });
    for (const u of FUNNEL_USERS) await recordProductEvent('policy_first_saved', { userId: u });
    await recordProductEvent('policy_first_executed', { userId: 'dv-a', properties: { source: 'dashboard' } });
    await recordProductEvent('evidence_exported', { userId: 'dv-a', properties: { format: 'json', scope: 'all' } });
    // 埋点上线前就注册的老用户：首存不计入周计数，证据导出照常计
    await recordProductEvent('policy_first_saved', { userId: 'legacy-user' });
    await recordProductEvent('evidence_exported', { userId: 'legacy-user' });

    await recordProductEvent('template_selected', { userId: 'dv-a', properties: { templateId: 'auto-insurance-quote', source: 'picker' } });
    await recordProductEvent('template_selected', { userId: 'dv-b', properties: { templateId: 'auto-insurance-quote', source: 'palette' } });
    await recordProductEvent('template_selected', { userId: 'dv-c', properties: { templateId: 'loan-evaluation', source: 'picker' } });

    await recordProductEvent('landing_viewed', { properties: { page: 'insurance-rating', utmSource: 'linkedin' } });
    await recordProductEvent('landing_viewed', { properties: { page: 'insurance-rating', referrerHost: 'news.ycombinator.com' } });
    await recordProductEvent('landing_viewed', { properties: { page: 'eligibility-rules' } });
    await recordProductEvent('pilot_application_submitted', { properties: { page: 'insurance-rating', freeMailDomain: false } });

    await guardCall('team-1');
    await guardCall('team-1');
    await guardCall('team-1', '/api/v1/guard/decisions', 'rate_limited');
    await guardCall('team-2', '/api/v1/guard/approvals/x/approve');
    await guardCall('team-3', '/api/policies/evaluate');

    const report = await loadDemandReport({ now: new Date(NOW.getTime() + 60_000) });

    const thisWeek = report.weekly.filter((r) => r.week === report.weekly[0].week);
    const byName = Object.fromEntries(thisWeek.map((r) => [r.name, r.count]));
    expect(byName).toMatchObject({
      signup_completed: 3, policy_first_saved: 3, policy_first_executed: 1, evidence_exported: 2,
      template_selected: 3, landing_viewed: 3, pilot_application_submitted: 1, guard_api_called: 3,
    });
    expect(report.templates).toEqual([
      { templateId: 'auto-insurance-quote', count: 2 },
      { templateId: 'loan-evaluation', count: 1 },
    ]);
    expect(report.funnel).toEqual({ signups: 3, verifiedSignups: 2, firstSaved: 2, firstExecuted: 1, evidenceExported: 1 });
    expect(report.landing).toEqual([
      { page: 'insurance-rating', views: 2, submissions: 1 },
      { page: 'eligibility-rules', views: 1, submissions: 0 },
    ]);
    expect(report.sources).toEqual([
      { source: '(direct)', views: 1 },
      { source: 'linkedin', views: 1 },
      { source: 'news.ycombinator.com', views: 1 },
    ]);
    expect(report.guardByTenant).toEqual([
      { tenant: pseudonymize('tenant', 'team-1'), count: 2 },
      { tenant: pseudonymize('tenant', 'team-2'), count: 1 },
    ]);
    expect(JSON.stringify(report)).not.toContain('team-1');
  });

  it('窗口外的事件不计入', async () => {
    await db.insert(productEvents).values({
      id: crypto.randomUUID(), name: 'landing_viewed', properties: { page: 'credit-decisions' },
      createdAt: new Date(NOW.getTime() - 200 * 24 * 3600 * 1000),
    });
    const report = await loadDemandReport({ weeks: 12 });
    expect(report.weekly).toEqual([]);
    expect(report.landing).toEqual([]);
  });

  it('试点申请：enum 数组列落库、最新在前列出、CSV 导出', async () => {
    const first = parsePilotApplication({
      email: 'a@gmail.com', company: 'Solo', role: 'other', useCases: ['eligibility_rules', 'other'],
      consent: true, page: 'eligibility-rules', locale: 'zh',
    });
    const second = parsePilotApplication({
      email: 'b@bank.example', company: 'Bank', role: 'credit_risk', useCases: ['credit_decisions'],
      consent: true, page: 'credit-decisions', locale: 'en', attribution: { utmSource: 'newsletter' },
    });
    if (!first.ok || !second.ok) throw new Error('fixture invalid');
    await insertPilotApplication(first.value, new Date(NOW.getTime() - 1000));
    await insertPilotApplication(second.value, NOW);

    const rows = await listPilotApplications();
    expect(rows.map((r) => r.email)).toEqual(['b@bank.example', 'a@gmail.com']);
    expect(rows[1].useCases).toEqual(['eligibility_rules', 'other']);
    expect(rows[1].freeMailDomain).toBe(true);
    expect(rows[0].utmSource).toBe('newsletter');

    const csv = pilotApplicationsToCsv(rows);
    expect(csv.split('\r\n')).toHaveLength(4);
    expect(csv).toContain('eligibility_rules|other');
  });

  it('保留期：事件 13 个月、申请 24 个月；按邮箱 24 小时去重；管理员删除', async () => {
    const now = new Date();
    const monthsAgo = (m: number) => { const d = new Date(now); d.setUTCMonth(d.getUTCMonth() - m); return d; };
    await db.insert(productEvents).values([
      { id: crypto.randomUUID(), name: 'landing_viewed', properties: {}, createdAt: monthsAgo(14) },
      { id: crypto.randomUUID(), name: 'landing_viewed', properties: {}, createdAt: monthsAgo(12) },
    ]);
    expect(await purgeExpiredProductEvents(now)).toBe(1);
    expect(await db.select().from(productEvents)).toHaveLength(1);

    const parsed = parsePilotApplication({
      email: 'old@corp.example', company: 'Old', role: 'other', useCases: ['other'], consent: true,
      page: 'credit-decisions', locale: 'en',
    });
    if (!parsed.ok) throw new Error('fixture invalid');
    const oldId = await insertPilotApplication(parsed.value, monthsAgo(25));
    const keepId = await insertPilotApplication({ ...parsed.value, email: 'new@corp.example' }, monthsAgo(23));
    expect(await purgeExpiredPilotApplications(now)).toBe(1);
    expect((await listPilotApplications()).map((r) => r.id)).toEqual([keepId]);
    void oldId;

    const recent = await insertPilotApplication({ ...parsed.value, email: 'dup@corp.example' }, new Date(now.getTime() - 3600_000));
    expect(await hasRecentPilotApplication('dup@corp.example', now)).toBe(true);
    expect(await hasRecentPilotApplication('dup@corp.example', new Date(now.getTime() + 24 * 3600_000))).toBe(false);
    expect(await hasRecentPilotApplication('other@corp.example', now)).toBe(false);

    expect(await deletePilotApplication(recent)).toBe(true);
    expect(await deletePilotApplication(recent)).toBe(false);
  });
});
