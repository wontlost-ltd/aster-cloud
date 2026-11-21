/**
 * AI 审计数据清理 cron（每天 04:00 UTC）
 *
 * 删除两类过期数据：
 *   1. encryptedPrompt / encryptedCompletion（180 天前）
 *      - 保留：promptHash / redactedPrompt / safetyFlags / status / costCents
 *      - 删除原文加密列，满足 GDPR 数据最小化 + 国内法规 ≥6 月
 *   2. signupAttempts（24h 前，无须保留）
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cron-auth';
import { db, aiUsageRecords, signupAttempts } from '@/lib/prisma';
import { lt, sql } from 'drizzle-orm';
import { rowsOf } from '@/db/result';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RETENTION_DAYS = 180;
const SIGNUP_ATTEMPT_TTL_HOURS = 24;

export async function GET(request: NextRequest) {
  // R21-Critical-2: fail-closed cron auth via shared helper
  const guard = requireCronAuth(request);
  if (guard) return guard;

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString();

  // 1. 抹除 180 天前的加密原文（保留聚合可分析字段）
  const auditCleared = await db.execute(sql`
    UPDATE "AiUsageRecord"
    SET "encryptedPrompt" = NULL,
        "encryptedCompletion" = NULL
    WHERE "createdAt" < ${cutoffIso}::timestamp
      AND ("encryptedPrompt" IS NOT NULL OR "encryptedCompletion" IS NOT NULL)
    RETURNING id
  `);
  const auditClearedCount = rowsOf<unknown>(auditCleared).length;

  // 2. 删除 24h+ 的注册尝试（限流计数器不需要更长保留）
  const signupCutoff = new Date(Date.now() - SIGNUP_ATTEMPT_TTL_HOURS * 60 * 60 * 1000);
  const signupDeleted = await db
    .delete(signupAttempts)
    .where(lt(signupAttempts.createdAt, signupCutoff))
    .returning({ id: signupAttempts.id });

  void aiUsageRecords; // 保留 import

  console.log(
    `[ai-audit-cleanup] cleared encrypted on ${auditClearedCount} records, deleted ${signupDeleted.length} signup attempts`
  );

  return NextResponse.json({
    cutoff_iso: cutoffIso,
    audit_records_cleared: auditClearedCount,
    signup_attempts_deleted: signupDeleted.length,
  });
}
