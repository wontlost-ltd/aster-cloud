/**
 * GDPR Article 15 — 用户数据可访问权
 *
 * 返回当前用户的所有 AI 审计记录（解密原文）。
 * - 仅本人可调取（NextAuth session）
 * - 加密原文实时解密；safetyFlags / redactedPrompt 直返
 * - 不返回他人数据；不暴露管理元字段
 * - AI 工作台已部署时，合并工作台存储的对话与审计到 `aiWorkspace`（F23）；工作台调用失败
 *   不影响 cloud 数据的导出，`aiWorkspace` 置为 `{ error: 'unavailable' }`，由界面提示未包含
 */
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db } from '@/lib/prisma';
import { sql } from 'drizzle-orm';
import { errorEnvelope } from '@/lib/api/error-envelope';
import { exportAiWorkspaceData } from '@/lib/ai-workspace-gdpr';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;
  const secret = process.env.AI_AUDIT_ENCRYPTION_SECRET;
  if (!secret) {
    // 部署配置缺失（Worker secret 未设置）：记日志供运维排查，客户端拿到结构化错误 +
    // requestId，由界面显示本地化提示，而不是这里的英文原文。
    const env = errorEnvelope({
      status: 503,
      code: 'audit_export_unavailable',
      message: 'AI data export is temporarily unavailable.',
    });
    console.error(
      '[ai-data-export] AI_AUDIT_ENCRYPTION_SECRET is not configured',
      env.headers.get('x-request-id'),
    );
    return env;
  }

  // 解密 prompt / completion；非加密字段原样返回。
  // 密钥与入库时不一致（被轮换）时 pgp_sym_decrypt 会抛错——同样返回结构化错误并记日志。
  let result: unknown;
  try {
    result = await db.execute(sql`
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
        CASE WHEN "encryptedPrompt" IS NOT NULL
          THEN pgp_sym_decrypt("encryptedPrompt"::bytea, ${secret}::text)
          ELSE NULL
        END AS prompt,
        CASE WHEN "encryptedCompletion" IS NOT NULL
          THEN pgp_sym_decrypt("encryptedCompletion"::bytea, ${secret}::text)
          ELSE NULL
        END AS completion
      FROM "AiUsageRecord"
      WHERE "userId" = ${userId}
      ORDER BY "createdAt" DESC
    `);
  } catch (err) {
    const env = errorEnvelope({
      status: 500,
      code: 'audit_export_failed',
      message: 'AI data export failed.',
    });
    console.error('[ai-data-export] export query failed', env.headers.get('x-request-id'), err);
    return env;
  }

  const records = result as unknown as Array<Record<string, unknown>>;
  const workspace = await exportAiWorkspaceData(userId);

  return NextResponse.json({
    user_id: userId,
    exported_at: new Date().toISOString(),
    record_count: records.length,
    records,
    // 工作台未部署时不出现此键；失败时只给固定错误码，不透出上游原因。
    ...(workspace.status === 'ok' ? { aiWorkspace: workspace.data } : {}),
    ...(workspace.status === 'error' ? { aiWorkspace: { error: 'unavailable' } } : {}),
  });
}
