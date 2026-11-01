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
  /**
   * 每周（周一起算，UTC）各事件计数，周倒序。policy_first_* 只计埋点上线后注册的用户
   * （有 signup_completed 事件的 actor），老用户上线后的「首次」不计入。
   */
  weekly: Array<{ week: string; name: string; count: number }>;
  /** 新建策略时选中的模板分布。 */
  templates: Array<{ templateId: string; count: number }>;
  /**
   * 漏斗：signups 为窗口内全部注册；分母 verifiedSignups 只算已验证邮箱的注册（排除未验证 / 垃圾注册），
   * 各步骤人数都在已验证 cohort 内统计（步骤可发生在任意时间）。
   */
  funnel: { signups: number; verifiedSignups: number; firstSaved: number; firstExecuted: number; evidenceExported: number };
  /** 各落地页访问与申请提交数。 */
  landing: Array<{ page: string; views: number; submissions: number }>;
  /** 落地页访问来源：utm_source 优先，其次 referrer 主机名，都没有记 (direct)。 */
  sources: Array<{ source: string; views: number }>;
  /** Guard 直连判定调用（POST /api/v1/guard/*，status=success）按租户计数（租户 id 已假名化）。 */
  guardByTenant: Array<{ tenant: string; count: number }>;
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

const num = (v: unknown) => Number(v ?? 0);

/** postgres-js 未解析数组类型时会返回 `{a,b}` 文本，这里兜底解析（事件名不含逗号与引号）。 */
function parsePgArray(text: string): string[] {
  const inner = text.replace(/^\{|\}$/g, '');
  return inner ? inner.split(',') : [];
}

export async function loadDemandReport(options: { weeks?: number; now?: Date } = {}): Promise<DemandReport> {
  const weeks = options.weeks ?? 12;
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - weeks * 7 * 24 * 3600 * 1000);
  // 原生 sql 模板里的 Date 参数 postgres-js 不会自动序列化：传 ISO 串并显式转 timestamp（列为 UTC 无时区）。
  const sinceParam = since.toISOString();

  const [weekly, templates, funnel, verifiedUsers, landing, sources, guard] = await Promise.all([
    db.execute(sql`
      SELECT to_char(date_trunc('week', "createdAt"), 'YYYY-MM-DD') AS "week", "name", count(*)::int AS "count"
      FROM "ProductEvent"
      WHERE "createdAt" >= ${sinceParam}::timestamp
        AND ("name" NOT IN ('policy_first_saved', 'policy_first_executed')
          OR "actorId" IN (SELECT "actorId" FROM "ProductEvent" WHERE "name" = 'signup_completed'))
      GROUP BY 1, 2
      UNION ALL
      SELECT to_char(date_trunc('week', "createdAt"), 'YYYY-MM-DD'), ${GUARD_API_EVENT}, count(*)::int
      FROM "ApiCallRecord"
      WHERE "createdAt" >= ${sinceParam}::timestamp AND "endpointPath" LIKE ${GUARD_PATH_PATTERN} AND "status" = 'success'
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
      )
      SELECT c."actorId",
        coalesce(array_agg(DISTINCT e."name") FILTER (WHERE e."name" IS NOT NULL), '{}') AS "steps"
      FROM cohort c
      LEFT JOIN "ProductEvent" e ON e."actorId" = c."actorId"
        AND e."name" IN ('policy_first_saved', 'policy_first_executed', 'evidence_exported')
      GROUP BY c."actorId"
    `),
    // 已验证邮箱的注册用户（含 OAuth 建号时即验证的）：在 JS 里假名化后与漏斗 cohort 求交。
    // 留 1 天余量：事件时间与 User.createdAt 可能跨窗口边界。
    db.execute(sql`
      SELECT "id" FROM "User"
      WHERE "emailVerified" IS NOT NULL AND "createdAt" >= ${sinceParam}::timestamp - interval '1 day'
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
      WHERE "createdAt" >= ${sinceParam}::timestamp AND "endpointPath" LIKE ${GUARD_PATH_PATTERN} AND "status" = 'success'
      GROUP BY 1
      ORDER BY 2 DESC
      LIMIT 50
    `),
  ]);

  const verified = new Set(
    rowsOf<{ id: string }>(verifiedUsers)
      .map((r) => pseudonymize('user', r.id))
      .filter((v): v is string => v !== null),
  );
  const cohort = rowsOf<{ actorId: string; steps: string[] | string }>(funnel).map((r) => ({
    actorId: r.actorId,
    steps: new Set(Array.isArray(r.steps) ? r.steps : parsePgArray(r.steps)),
  }));
  const verifiedCohort = cohort.filter((c) => verified.has(c.actorId));
  const reached = (step: string) => verifiedCohort.filter((c) => c.steps.has(step)).length;

  return {
    since,
    weekly: rowsOf<{ week: string; name: string; count: unknown }>(weekly).map((r) => ({
      week: r.week, name: r.name, count: num(r.count),
    })),
    templates: rowsOf<{ templateId: string; count: unknown }>(templates).map((r) => ({
      templateId: r.templateId, count: num(r.count),
    })),
    funnel: {
      signups: cohort.length,
      verifiedSignups: verifiedCohort.length,
      firstSaved: reached('policy_first_saved'),
      firstExecuted: reached('policy_first_executed'),
      evidenceExported: reached('evidence_exported'),
    },
    landing: rowsOf<{ page: string; views: unknown; submissions: unknown }>(landing).map((r) => ({
      page: r.page, views: num(r.views), submissions: num(r.submissions),
    })),
    sources: rowsOf<{ source: string; views: unknown }>(sources).map((r) => ({ source: r.source, views: num(r.views) })),
    guardByTenant: rowsOf<{ tenantId: string | null; count: unknown }>(guard).map((r) => ({
      tenant: r.tenantId ? (pseudonymize('tenant', r.tenantId) ?? '(salt unset)') : '(none)',
      count: num(r.count),
    })),
  };
}
