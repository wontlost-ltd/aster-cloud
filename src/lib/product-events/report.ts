/**
 * 需求验证汇总（管理端 /admin/demand 使用）。
 *
 * 数据来源：
 * - ProductEvent：注册、模板选择、首次保存 / 执行、证据导出、审批收件箱访问、落地页访问与表单提交；
 * - ApiCallRecord：aster-api 已按租户上报的 Guard 判定调用（endpointPath 以 /api/v1/guard/ 开头），
 *   只计数，不读任何请求内容；该表按 90 天滚动清理，更早的 Guard 计数不可得。
 *
 * 所有聚合在库内完成，返回的只有计数与假名化的租户 id。
 */
import { sql } from 'drizzle-orm';
import { db } from '@/lib/prisma';
import { GUARD_API_EVENT } from './definitions';
import { pseudonymize } from './server';

const GUARD_PATH_PATTERN = '/api/v1/guard/%';

export interface DemandReport {
  since: Date;
  /** 每周（周一起算，UTC）各事件计数，周倒序。 */
  weekly: Array<{ week: string; name: string; count: number }>;
  /** 新建策略时选中的模板分布。 */
  templates: Array<{ templateId: string; count: number }>;
  /** 窗口内注册的用户中，到达各步骤的人数（步骤可发生在窗口内任意时间）。 */
  funnel: { signups: number; firstSaved: number; firstExecuted: number; evidenceExported: number };
  /** 各落地页访问与申请提交数。 */
  landing: Array<{ page: string; views: number; submissions: number }>;
  /** 落地页访问来源：utm_source 优先，其次 referrer 主机名，都没有记 (direct)。 */
  sources: Array<{ source: string; views: number }>;
  /** Guard 调用按租户计数（租户 id 已假名化）。 */
  guardByTenant: Array<{ tenant: string; count: number }>;
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

const num = (v: unknown) => Number(v ?? 0);

export async function loadDemandReport(options: { weeks?: number; now?: Date } = {}): Promise<DemandReport> {
  const weeks = options.weeks ?? 12;
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - weeks * 7 * 24 * 3600 * 1000);
  // 原生 sql 模板里的 Date 参数 postgres-js 不会自动序列化：传 ISO 串并显式转 timestamp（列为 UTC 无时区）。
  const sinceParam = since.toISOString();

  const [weekly, templates, funnel, landing, sources, guard] = await Promise.all([
    db.execute(sql`
      SELECT to_char(date_trunc('week', "createdAt"), 'YYYY-MM-DD') AS "week", "name", count(*)::int AS "count"
      FROM "ProductEvent"
      WHERE "createdAt" >= ${sinceParam}::timestamp
      GROUP BY 1, 2
      UNION ALL
      SELECT to_char(date_trunc('week', "createdAt"), 'YYYY-MM-DD'), ${GUARD_API_EVENT}, count(*)::int
      FROM "ApiCallRecord"
      WHERE "createdAt" >= ${sinceParam}::timestamp AND "endpointPath" LIKE ${GUARD_PATH_PATTERN}
      GROUP BY 1
      ORDER BY 1 DESC, 2
    `),
    db.execute(sql`
      SELECT "properties"->>'templateId' AS "templateId", count(*)::int AS "count"
      FROM "ProductEvent"
      WHERE "name" = 'template_selected' AND "createdAt" >= ${sinceParam}::timestamp AND "properties" ? 'templateId'
      GROUP BY 1
      ORDER BY 2 DESC, 1
    `),
    db.execute(sql`
      WITH cohort AS (
        SELECT DISTINCT "actorId" FROM "ProductEvent"
        WHERE "name" = 'signup_completed' AND "createdAt" >= ${sinceParam}::timestamp AND "actorId" IS NOT NULL
      ),
      reached AS (
        SELECT e."name", count(DISTINCT e."actorId")::int AS "n"
        FROM "ProductEvent" e JOIN cohort c ON c."actorId" = e."actorId"
        WHERE e."name" IN ('policy_first_saved', 'policy_first_executed', 'evidence_exported')
        GROUP BY e."name"
      )
      SELECT
        (SELECT count(*)::int FROM cohort) AS "signups",
        coalesce((SELECT "n" FROM reached WHERE "name" = 'policy_first_saved'), 0) AS "firstSaved",
        coalesce((SELECT "n" FROM reached WHERE "name" = 'policy_first_executed'), 0) AS "firstExecuted",
        coalesce((SELECT "n" FROM reached WHERE "name" = 'evidence_exported'), 0) AS "evidenceExported"
    `),
    db.execute(sql`
      SELECT "properties"->>'page' AS "page",
        count(*) FILTER (WHERE "name" = 'landing_viewed')::int AS "views",
        count(*) FILTER (WHERE "name" = 'pilot_application_submitted')::int AS "submissions"
      FROM "ProductEvent"
      WHERE "name" IN ('landing_viewed', 'pilot_application_submitted')
        AND "createdAt" >= ${sinceParam}::timestamp AND "properties" ? 'page'
      GROUP BY 1
      ORDER BY 2 DESC, 1
    `),
    db.execute(sql`
      SELECT coalesce("properties"->>'utmSource', "properties"->>'referrerHost', '(direct)') AS "source",
        count(*)::int AS "views"
      FROM "ProductEvent"
      WHERE "name" = 'landing_viewed' AND "createdAt" >= ${sinceParam}::timestamp
      GROUP BY 1
      ORDER BY 2 DESC, 1
      LIMIT 50
    `),
    db.execute(sql`
      SELECT "tenantId", count(*)::int AS "count"
      FROM "ApiCallRecord"
      WHERE "createdAt" >= ${sinceParam}::timestamp AND "endpointPath" LIKE ${GUARD_PATH_PATTERN}
      GROUP BY 1
      ORDER BY 2 DESC
      LIMIT 50
    `),
  ]);

  const f = rowsOf<Record<string, unknown>>(funnel)[0] ?? {};
  return {
    since,
    weekly: rowsOf<{ week: string; name: string; count: unknown }>(weekly).map((r) => ({
      week: r.week, name: r.name, count: num(r.count),
    })),
    templates: rowsOf<{ templateId: string; count: unknown }>(templates).map((r) => ({
      templateId: r.templateId, count: num(r.count),
    })),
    funnel: {
      signups: num(f.signups),
      firstSaved: num(f.firstSaved),
      firstExecuted: num(f.firstExecuted),
      evidenceExported: num(f.evidenceExported),
    },
    landing: rowsOf<{ page: string; views: unknown; submissions: unknown }>(landing).map((r) => ({
      page: r.page, views: num(r.views), submissions: num(r.submissions),
    })),
    sources: rowsOf<{ source: string; views: unknown }>(sources).map((r) => ({ source: r.source, views: num(r.views) })),
    guardByTenant: rowsOf<{ tenantId: string | null; count: unknown }>(guard).map((r) => ({
      tenant: r.tenantId ? pseudonymize('tenant', r.tenantId) : '(none)',
      count: num(r.count),
    })),
  };
}
