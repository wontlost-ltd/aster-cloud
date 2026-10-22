/**
 * GDPR Article 17 — 用户被遗忘权
 *
 * DELETE：立即抹除当前用户所有 AI 审计原文（encryptedPrompt / encryptedCompletion）
 *   - 保留：聚合统计字段（promptTokens, costCents, status）— 计费/合规/异常检测仍需
 *   - 同步删除：redactedPrompt（用户主动要求遗忘，应一并清空脱敏文本）
 *   - 不删除整行：promptHash 留作反盗刷指纹；status 留作账单凭证
 *
 * cloud 自身清除完成后再抹除 AI 工作台存储的对话与审计（F23），结果放在 `aiWorkspace`：
 *   - 成功：删除计数 + 法律保留未删除的线程（held / tenantHold），由界面告知用户；
 *   - 失败：`{ error: 'unavailable' }`，cloud 部分已生效，界面提示部分失败；
 *   - 工作台未部署：不出现此键。
 */
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db } from '@/lib/prisma';
import { sql } from 'drizzle-orm';
import { eraseAiWorkspaceData } from '@/lib/ai-workspace-gdpr';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;

  const result = await db.execute(sql`
    UPDATE "AiUsageRecord"
    SET "encryptedPrompt" = NULL,
        "encryptedCompletion" = NULL,
        "redactedPrompt" = NULL
    WHERE "userId" = ${userId}
      AND ("encryptedPrompt" IS NOT NULL
        OR "encryptedCompletion" IS NOT NULL
        OR "redactedPrompt" IS NOT NULL)
    RETURNING id
  `);

  const affected = (result as unknown as Array<unknown>).length;

  console.warn(`[gdpr-erasure] user ${userId} requested data deletion, ${affected} records cleared`);

  const workspace = await eraseAiWorkspaceData(userId);
  if (workspace.status === 'ok' && (workspace.data.tenantHold || workspace.data.held.length > 0)) {
    // 法律保留的线程未被删除：记一行供客服跟进（与上方 gdpr-erasure 日志同一用户上下文）。
    console.warn(
      `[gdpr-erasure] user ${userId} ai-workspace legal hold: tenantHold=${workspace.data.tenantHold} held=${workspace.data.held.length}`,
    );
  }

  return NextResponse.json({
    user_id: userId,
    deleted_at: new Date().toISOString(),
    records_cleared: affected,
    ...(workspace.status === 'ok' ? { aiWorkspace: workspace.data } : {}),
    ...(workspace.status === 'error' ? { aiWorkspace: { error: 'unavailable' } } : {}),
  });
}
