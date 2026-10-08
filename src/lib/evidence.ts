// 证据导出持久化层（复用 ComplianceReport 表——type='custom' + data.kind='evidence-export'，不改 schema）。
//
// 审计物必须**可复现/可重下载**：导出时把 bundle 持久化，用户下季度还能拉到字节完全一致的同一份
// （on-demand 重生会因新执行/留存清理而漂移）。替换旧 lib/compliance.ts（假分报告）。

import { db, complianceReports, policies } from '@/lib/prisma';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  buildBundle,
  buildEvidenceEntry,
  receiptFor,
  serializeBundle,
  type EvidenceRow,
} from '@/services/evidence/bundle';
import { queryEvidenceExecutions } from '@/lib/evidence-export';
import {
  createLimiter,
  fetchDecisionReceipts,
  fetchReceipts,
  mergeLookups,
  RECEIPT_CONCURRENCY,
  type Limiter,
  type ReceiptLookup,
} from '@/services/evidence/receipts-client';
import {
  guardApprovalReviewers,
  loadProofReviewers,
  loadVersionApprovalReviewers,
  type Reviewer,
} from '@/services/evidence/reviewers';
import type {
  EvidenceBundle,
  EvidenceExportRequest,
  EvidenceManifest,
} from '@/services/evidence/types';

/**
 * ComplianceReport.data 里证据导出的存储形态（discriminated by kind）。
 * 历史行可能是 schemaVersion '1' 的 manifest/entries：读取侧只按原样返回，不做重算或升级。
 */
interface EvidenceExportData {
  kind: 'evidence-export';
  manifest: EvidenceManifest;
  bundle: EvidenceBundle;
  format: EvidenceExportRequest['format'];
}

/** 按租户把行上的某个 id 分组（空 id 跳过），供收据客户端按租户批量查询。 */
function idsByTenant(rows: readonly EvidenceRow[], idOf: (r: EvidenceRow) => string | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const id = idOf(r);
    if (!id) continue;
    const list = out.get(r.policyTenantId) ?? [];
    list.push(id);
    out.set(r.policyTenantId, list);
  }
  return out;
}

type ReceiptFetcher = (
  tenantId: string,
  ids: string[],
  fetchImpl: typeof fetch,
  limiter: Limiter,
) => Promise<ReceiptLookup>;

/**
 * 逐租户查询后合并为一份查找结果。收据客户端自身不抛错（失败记 unavailable）。
 * 所有租户共用调用方传入的限流器，故在途批次总数不随租户数增长。
 */
async function lookupByTenant(
  groups: Map<string, string[]>,
  fetcher: ReceiptFetcher,
  limiter: Limiter,
): Promise<ReceiptLookup> {
  return mergeLookups(await Promise.all([...groups].map(([tenant, ids]) => fetcher(tenant, ids, fetch, limiter))));
}

/**
 * 为每行拼装链收据与三来源复核者，生成 v2 条目。
 * ★租户前置：版本 id 只取自已按 userId 过滤的 rows，满足 loadProofReviewers/loadVersionApprovalReviewers 的约定。
 */
async function enrichEntries(rows: readonly EvidenceRow[]) {
  const versionIds = [...new Set(rows.map((r) => r.policyVersionRowId).filter((v): v is string => !!v))];
  // 一个导出一个限流器：两类查找 × 所有租户合计在途批次 ≤ RECEIPT_CONCURRENCY。
  const limiter = createLimiter(RECEIPT_CONCURRENCY);
  const [lookup, guardLookup, proofs, approvals] = await Promise.all([
    lookupByTenant(idsByTenant(rows, (r) => r.evidenceCorrelationId), fetchReceipts, limiter),
    lookupByTenant(idsByTenant(rows, (r) => r.guardDecisionId), fetchDecisionReceipts, limiter),
    loadProofReviewers(versionIds),
    loadVersionApprovalReviewers(versionIds),
  ]);
  const versionReviewers = (vid: string | null): Reviewer[] =>
    vid ? [...(proofs.get(vid) ?? []), ...(approvals.get(vid) ?? [])] : [];
  const guardReviewers = (did: string | null): Reviewer[] =>
    did ? guardApprovalReviewers(guardLookup.approvals.get(did) ?? []) : [];
  return rows.map((r) =>
    buildEvidenceEntry(r, receiptFor(r, lookup), [
      ...versionReviewers(r.policyVersionRowId),
      ...guardReviewers(r.guardDecisionId),
    ]),
  );
}

/**
 * 创建证据导出：查真实执行 → 取链收据/复核者 → 组装 v2 bundle → 持久化（generating→completed/failed）。
 * 收据取不到不使导出失败：条目如实标 unavailable，manifest.notes 计数。
 * 返回 { id, manifest }（不回整个 bundle，下载走 getEvidenceExportBundle）。
 */
export async function createEvidenceExport(
  userId: string,
  request: EvidenceExportRequest,
  now: Date = new Date(),
): Promise<{ id: string; manifest: EvidenceManifest }> {
  // 策略快照（单策略时取名字/版本；全部时标 scope=all）。
  let policySnapshot: EvidenceManifest['policy'] = { scope: 'all' };
  let titleScope = 'all policies';
  if (request.policyId) {
    const p = await db.query.policies.findFirst({
      where: and(eq(policies.id, request.policyId), eq(policies.userId, userId)),
      columns: { id: true, name: true, version: true },
    });
    if (!p) {
      throw new Error('policy_not_found');
    }
    // manifest 记策略**当前**版本号（导出时刻）；每条 entry 各自带执行时的版本号（可能不同版本）。
    policySnapshot = { id: p.id, name: p.name, version: p.version ?? null, policyVersionRowId: null };
    titleScope = p.name;
  }

  const rangeLabel = formatRangeLabel(request.startDate, request.endDate);
  const [reportRecord] = await db
    .insert(complianceReports)
    .values({
      id: crypto.randomUUID(),
      userId,
      type: 'custom',
      title: `Evidence export — ${titleScope} — ${rangeLabel}`,
      status: 'generating',
      policyIds: request.policyId ? [request.policyId] : [],
      period: rangeLabel,
    })
    .returning();

  try {
    // 查真实执行（超限抛 EvidenceTooLargeError，由路由转 413）。
    const rows = await queryEvidenceExecutions({
      userId,
      policyId: request.policyId,
      startDate: request.startDate,
      endDate: request.endDate,
      verifiableOnly: request.verifiableOnly,
    });

    const bundle = buildBundle({
      policy: policySnapshot,
      range: { start: request.startDate ?? null, end: request.endDate ?? null },
      entries: await enrichEntries(rows),
      generatedAt: now,
    });

    const data: EvidenceExportData = {
      kind: 'evidence-export',
      manifest: bundle.manifest,
      bundle,
      format: request.format,
    };

    await db
      .update(complianceReports)
      .set({ status: 'completed', data: data as object, completedAt: now })
      .where(eq(complianceReports.id, reportRecord.id));

    return { id: reportRecord.id, manifest: bundle.manifest };
  } catch (error) {
    await db
      .update(complianceReports)
      .set({ status: 'failed' })
      .where(eq(complianceReports.id, reportRecord.id));
    throw error;
  }
}

// 只认「证据导出」行——排除旧假分 ComplianceReport 老行（Codex 审查：否则旧假分报告会漏进新
// 证据页历史列表，且点下载因 kind 不匹配 404）。type='custom' + data->>'kind'='evidence-export'。
const isEvidenceExport = sql`${complianceReports.data} ->> 'kind' = 'evidence-export'`;

export async function listEvidenceExports(userId: string, limit = 20) {
  return db.query.complianceReports.findMany({
    where: and(eq(complianceReports.userId, userId), isEvidenceExport),
    orderBy: [desc(complianceReports.createdAt)],
    limit,
  });
}

export async function getEvidenceExport(userId: string, id: string) {
  return db.query.complianceReports.findFirst({
    where: and(
      eq(complianceReports.id, id),
      eq(complianceReports.userId, userId),
      isEvidenceExport,
    ),
  });
}

/**
 * 元数据 + manifest（**不含 bundle.entries**）——供 GET /api/reports/[id]。避免元数据接口返回整包
 * entries（绕过下载端点的 attachment/no-store 边界 + 大响应，Codex 审查）。null=不存在/越权/非证据行。
 */
export async function getEvidenceExportMetadata(userId: string, id: string) {
  const record = await getEvidenceExport(userId, id);
  if (!record) return null;
  const data = record.data as unknown as EvidenceExportData | null;
  const manifest = data?.kind === 'evidence-export' ? data.manifest : null;
  return {
    id: record.id,
    title: record.title,
    status: record.status,
    period: record.period,
    format: data?.format ?? null,
    manifest,
    createdAt: record.createdAt,
    completedAt: record.completedAt,
  };
}

/**
 * 取导出的可下载字节（重下载：同一份字节完全一致）。返回 null 表示不存在/越权/未完成。
 */
export async function getEvidenceExportBundle(
  userId: string,
  id: string,
): Promise<{ body: string; format: EvidenceExportRequest['format']; manifest: EvidenceManifest } | null> {
  const record = await getEvidenceExport(userId, id);
  if (!record || record.status !== 'completed' || !record.data) return null;
  const data = record.data as unknown as EvidenceExportData;
  if (data.kind !== 'evidence-export') return null;
  return {
    body: serializeBundle(data.bundle, data.format),
    format: data.format,
    manifest: data.manifest,
  };
}

/** YYYYMMDD-YYYYMMDD 范围标签（缺一端用 'begin'/'now'）。 */
function formatRangeLabel(start?: Date, end?: Date): string {
  const s = start ? ymd(start) : 'begin';
  const e = end ? ymd(end) : 'now';
  return `${s}-${e}`;
}
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}
