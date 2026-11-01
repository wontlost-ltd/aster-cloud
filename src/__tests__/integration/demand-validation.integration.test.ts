// 需求验证（产品分析事件 + 试点申请）真库集成测试。
//
// 只有真库能验的：dedupeKey 唯一索引让 once 事件在并发 / 多实例下只落一行；PilotUseCase enum 数组
// 列的读写；管理端汇总 SQL（周计数、模板分布、漏斗、落地页、来源、Guard 按租户）在真 Postgres 上的结果。
//
// Run: LICENSE_E2E=1 DATABASE_URL=<已迁移到最新的库> pnpm exec vitest run --config vitest.integration.config.ts demand-validation
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, productEvents, pilotApplications, apiCallRecords } from '@/lib/prisma';
import { pseudonymize, recordProductEvent, resetOnceCacheForTests } from '@/lib/product-events/server';
import { loadDemandReport } from '@/lib/product-events/report';
import {
  insertPilotApplication,
  listPilotApplications,
  parsePilotApplication,
  pilotApplicationsToCsv,
} from '@/lib/pilot-applications';
import { setupTestDb, teardownTestDb } from './setup-postgres';

const NOW = new Date();

async function guardCall(tenantId: string, endpointPath = '/api/v1/guard/decisions') {
  await db.insert(apiCallRecords).values({
    id: crypto.randomUUID(), userId: 'u-api', tenantId, periodMonth: '2026-11', endpointPath, status: 'success',
  });
}

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

  it('汇总：周计数含 Guard 调用，模板分布、漏斗、落地页、来源、Guard 按租户', async () => {
    // 3 人注册；2 人首存；1 人首跑并导出；另有窗口外注册者的导出不计入漏斗
    for (const u of ['a', 'b', 'c']) await recordProductEvent('signup_completed', { userId: u, tenantId: u });
    await recordProductEvent('policy_first_saved', { userId: 'a' });
    await recordProductEvent('policy_first_saved', { userId: 'b' });
    await recordProductEvent('policy_first_executed', { userId: 'a', properties: { source: 'dashboard' } });
    await recordProductEvent('evidence_exported', { userId: 'a', properties: { format: 'json', scope: 'all' } });
    await recordProductEvent('evidence_exported', { userId: 'outsider' });

    await recordProductEvent('template_selected', { userId: 'a', properties: { templateId: 'auto-insurance-quote', source: 'picker' } });
    await recordProductEvent('template_selected', { userId: 'b', properties: { templateId: 'auto-insurance-quote', source: 'palette' } });
    await recordProductEvent('template_selected', { userId: 'c', properties: { templateId: 'loan-evaluation', source: 'picker' } });

    await recordProductEvent('landing_viewed', { properties: { page: 'insurance-rating', utmSource: 'linkedin' } });
    await recordProductEvent('landing_viewed', { properties: { page: 'insurance-rating', referrerHost: 'news.ycombinator.com' } });
    await recordProductEvent('landing_viewed', { properties: { page: 'eligibility-rules' } });
    await recordProductEvent('pilot_application_submitted', { properties: { page: 'insurance-rating', freeMailDomain: false } });

    await guardCall('team-1');
    await guardCall('team-1');
    await guardCall('team-2', '/api/v1/guard/approvals/x/approve');
    await guardCall('team-3', '/api/policies/evaluate');

    const report = await loadDemandReport({ now: new Date(NOW.getTime() + 60_000) });

    const thisWeek = report.weekly.filter((r) => r.week === report.weekly[0].week);
    const byName = Object.fromEntries(thisWeek.map((r) => [r.name, r.count]));
    expect(byName).toMatchObject({
      signup_completed: 3, policy_first_saved: 2, policy_first_executed: 1, evidence_exported: 2,
      template_selected: 3, landing_viewed: 3, pilot_application_submitted: 1, guard_api_called: 3,
    });
    expect(report.templates).toEqual([
      { templateId: 'auto-insurance-quote', count: 2 },
      { templateId: 'loan-evaluation', count: 1 },
    ]);
    expect(report.funnel).toEqual({ signups: 3, firstSaved: 2, firstExecuted: 1, evidenceExported: 1 });
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
});
