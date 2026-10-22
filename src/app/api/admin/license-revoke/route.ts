/**
 * POST /api/admin/license-revoke — admin 撤销 license（SaaS only）。
 *
 * 流程：
 *   1. admin gate + IS_SAAS gate
 *   2. body 校验（reason 必须在白名单）
 *   3. INSERT into RevokedLicense（ON CONFLICT DO NOTHING — 幂等）
 *   4. 立即触发 publishRevocationManifest 重新签发新版 list
 *   5. 写 audit log
 *   6. 触发 Slack 通知（可选）
 *
 * dryRun=true 时只校验，不实际写入。
 *
 * 响应带 knownLicense：该 ID 是否在已签发记录（IssuedLicense）中。离线签发的许可证不在
 * 记录里，所以 false 不拒绝撤销，只供界面提示管理员核对 ID（防止手误撤错/撤空）。
 */

import { NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { requireAdmin } from '@/lib/admin-auth';
import { IS_SAAS } from '@/lib/deployment-mode';
import {
  db,
  auditLogs,
  issuedLicenses,
  revokedLicenses,
  revocationPublications,
} from '@/lib/prisma';
import { publishRevocationManifest } from '@/lib/revocation-publisher';
import type { RevocationReason } from '@/lib/license-revocation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UNDO_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * GET /api/admin/license-revoke — admin 拉取撤销列表 + 当前 publication 状态。
 *
 * 响应：{
 *   revoked: [{ licenseId, reason, revokedAt, revokedBy, notes?, customerRef?, undoExpiresAt }],
 *   currentPublication: { version, publishedAt, validUntil, revokedCount } | null
 * }
 */
export async function GET() {
  if (!IS_SAAS) return new NextResponse(null, { status: 404 });
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;

  const [revoked, currentPub] = await Promise.all([
    db.query.revokedLicenses.findMany({
      orderBy: [desc(revokedLicenses.revokedAt)],
    }),
    db.query.revocationPublications.findFirst({
      orderBy: [desc(revocationPublications.version)],
    }),
  ]);

  return NextResponse.json(
    {
      revoked: revoked.map((row) => ({
        licenseId: row.licenseId,
        reason: row.reason,
        revokedAt: row.revokedAt.toISOString(),
        revokedBy: row.revokedBy,
        notes: row.notes,
        customerRef: row.customerRef,
        undoExpiresAt: new Date(
          row.revokedAt.getTime() + UNDO_WINDOW_MS,
        ).toISOString(),
      })),
      currentPublication: currentPub
        ? {
            version: currentPub.version.toString(),
            publishedAt: currentPub.publishedAt.toISOString(),
            validUntil: currentPub.validUntil.toISOString(),
            revokedCount: currentPub.revokedCount,
          }
        : null,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

const REASONS: readonly RevocationReason[] = [
  'non-payment',
  'security',
  'renewal-superseded',
  'contract-terminated',
  'fraud',
];

// codex 审查 Major-5：body 验证长度 + 字符集（防止 storage bloat / 注入）
const LICENSE_ID_RE = /^lic_[A-Z0-9]{20,30}$/;
const MAX_NOTES_LEN = 2000;
const MAX_CUSTOMER_REF_LEN = 255;

interface RevokeBody {
  licenseId: string;
  reason: RevocationReason;
  notes?: string;
  customerRef?: string;
  dryRun?: boolean;
}

function isReason(value: unknown): value is RevocationReason {
  return (
    typeof value === 'string' &&
    REASONS.includes(value as RevocationReason)
  );
}

function parseBody(value: unknown): RevokeBody | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  if (typeof o.licenseId !== 'string') return null;
  const licenseId = o.licenseId.trim();
  // 严格白名单：仅 ULID-like 形式，防 path / SQL / Slack 注入
  if (!LICENSE_ID_RE.test(licenseId)) return null;
  if (!isReason(o.reason)) return null;
  if (o.notes !== undefined && typeof o.notes !== 'string') return null;
  if (o.customerRef !== undefined && typeof o.customerRef !== 'string') return null;
  if (o.dryRun !== undefined && typeof o.dryRun !== 'boolean') return null;
  const notes = o.notes?.trim() || undefined;
  const customerRef = o.customerRef?.trim() || undefined;
  if (notes && notes.length > MAX_NOTES_LEN) return null;
  if (customerRef && customerRef.length > MAX_CUSTOMER_REF_LEN) return null;
  return {
    licenseId,
    reason: o.reason,
    notes,
    customerRef,
    dryRun: o.dryRun,
  };
}

async function postSlack(body: RevokeBody, version: bigint): Promise<void> {
  const webhook = process.env.LICENSES_SLACK_WEBHOOK;
  if (!webhook) return;
  // codex 审查 Minor-7：webhook 加 timeout 防慢响应挂死整个 revoke 请求
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: '#licenses-ops',
        // 不在 Slack 发客户名 / customerRef，避免 PII 进入 Slack 审计范围
        text: `License revoked: ${body.licenseId} (reason=${body.reason}), manifest v${version.toString()}`,
      }),
      signal: controller.signal,
    });
  } catch {
    // Slack 是辅助通知；撤销 + publish + audit 才是权威状态
  } finally {
    clearTimeout(timer);
  }
}

/** 该许可证是否在已签发记录中（离线签发的不在）。 */
async function isKnownLicense(licenseId: string): Promise<boolean> {
  const row = await db.query.issuedLicenses.findFirst({
    where: eq(issuedLicenses.licenseId, licenseId),
    columns: { licenseId: true },
  });
  return row != null;
}

export async function POST(req: Request) {
  if (!IS_SAAS) return new NextResponse(null, { status: 404 });
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;

  let parsed: RevokeBody | null;
  try {
    parsed = parseBody(await req.json());
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return NextResponse.json({ error: 'invalid-request-body' }, { status: 400 });
  }

  const knownLicense = await isKnownLicense(parsed.licenseId);

  if (parsed.dryRun) {
    return NextResponse.json({
      dryRun: true,
      licenseId: parsed.licenseId,
      reason: parsed.reason,
      knownLicense,
    });
  }

  const now = new Date();
  await db
    .insert(revokedLicenses)
    .values({
      licenseId: parsed.licenseId,
      revokedAt: now,
      revokedBy: admin.userId,
      reason: parsed.reason,
      notes: parsed.notes,
      customerRef: parsed.customerRef,
      createdAt: now,
    })
    .onConflictDoNothing();

  const publication = await publishRevocationManifest({ now });
  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    userId: admin.userId,
    action: 'license.revoked',
    resource: 'license',
    resourceId: parsed.licenseId,
    metadata: {
      reason: parsed.reason,
      notes: parsed.notes,
      customerRef: parsed.customerRef,
      publishedVersion: publication.version.toString(),
      knownLicense,
    },
    createdAt: now,
  });
  await postSlack(parsed, publication.version);

  return NextResponse.json({
    licenseId: parsed.licenseId,
    revokedAt: now.toISOString(),
    publishedVersion: publication.version.toString(),
    knownLicense,
  });
}
