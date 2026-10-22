/**
 * GDPR Article 15 — 用户数据可访问权
 *
 * 返回当前用户的所有 AI 审计记录（解密原文）。
 * - 仅本人可调取（NextAuth session）
 * - 加密原文实时解密；safetyFlags / redactedPrompt 直返
 * - 不返回他人数据；不暴露管理元字段
 * - AI 工作台已部署时，合并工作台存储的对话与审计到 `aiWorkspace`（F23）；工作台调用失败
 *   不影响 cloud 数据的导出，`aiWorkspace` 置为 `{ error: 'unavailable' }`，由界面提示未包含
 * - 审计密钥缺失或解密失败时降级：仍返回记录的非加密字段（prompt / completion 为 null）与
 *   工作台数据，并附 `auditContent: { error: 'unavailable' }`，由界面提示原文部分未包含
 */
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db } from '@/lib/prisma';
import { sql, type SQL } from 'drizzle-orm';
import { errorEnvelope, safeErrorCode } from '@/lib/api/error-envelope';
import { exportAiWorkspaceData } from '@/lib/ai-workspace-gdpr';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 解密表达式；没有可用密钥时原文列直接给 NULL（降级导出）。 */
function decrypted(column: SQL, secret: string | null): SQL {
  if (secret === null) return sql`NULL`;
  return sql`CASE WHEN ${column} IS NOT NULL
    THEN pgp_sym_decrypt(${column}::bytea, ${secret}::text)
    ELSE NULL
  END`;
}

async function loadRecords(userId: string, secret: string | null) {
  const result = await db.execute(sql`
    SELECT
      id,
      "createdAt",
      "callKind",
      model,
      "promptTokens",
      "completionTokens",
      "costCents",
      "usedByok",
      status,
      "redactedPrompt",
      "safetyFlags",
      ${decrypted(sql`"encryptedPrompt"`, secret)} AS prompt,
      ${decrypted(sql`"encryptedCompletion"`, secret)} AS completion
    FROM "AiUsageRecord"
    WHERE "userId" = ${userId}
    ORDER BY "createdAt" DESC
  `);
  return result as unknown as Array<Record<string, unknown>>;
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;
  const requestId = crypto.randomUUID();
  const secret = process.env.AI_AUDIT_ENCRYPTION_SECRET || null;

  // 先按密钥解密；密钥缺失（部署漏配）或解密失败（密钥被轮换）时只放弃原文部分，
  // 其余字段与工作台数据照常导出，保证第 15 条访问权不因单一密钥问题整体失效。
  let records: Array<Record<string, unknown>> | null = null;
  if (secret === null) {
    console.error('[ai-data-export] AI_AUDIT_ENCRYPTION_SECRET is not configured', requestId);
  } else {
    try {
      records = await loadRecords(userId, secret);
    } catch (err) {
      // 查询把审计密钥作为绑定参数传入，驱动错误（DrizzleQueryError 的 message 含 params）会带出密钥：
      // 只记 requestId 与错误名/数据库错误码，绝不记录 err 本身或 err.message。
      console.error('[ai-data-export] audit decrypt failed', requestId, safeErrorCode(err));
    }
  }
  const auditContentAvailable = records !== null;

  if (records === null) {
    try {
      records = await loadRecords(userId, null);
    } catch (err) {
      const env = errorEnvelope({
        status: 500,
        code: 'audit_export_failed',
        message: 'AI data export failed.',
        requestId,
      });
      console.error('[ai-data-export] export query failed', requestId, safeErrorCode(err));
      return env;
    }
  }

  const workspace = await exportAiWorkspaceData(userId);

  // 降级导出时客户端无从知晓原因，响应头附 requestId 供客服关联日志。
  return NextResponse.json({
    user_id: userId,
    exported_at: new Date().toISOString(),
    record_count: records.length,
    records,
    // 原文无法解密时只给固定错误码，不透出原因。
    ...(auditContentAvailable ? {} : { auditContent: { error: 'unavailable' } }),
    // 工作台未部署时不出现此键；失败时只给固定错误码，不透出上游原因。
    ...(workspace.status === 'ok' ? { aiWorkspace: workspace.data } : {}),
    ...(workspace.status === 'error' ? { aiWorkspace: { error: 'unavailable' } } : {}),
  }, { headers: { 'x-request-id': requestId } });
}
