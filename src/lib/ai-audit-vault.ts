// AI 调用审计加密：原始 prompt / completion 用 pgcrypto 加密落库
//
// 安全约束：
//   - 主密钥 AI_AUDIT_ENCRYPTION_SECRET 独立于 BYOK key 加密（AI_KEY_ENCRYPTION_SECRET）
//     防止单一密钥泄漏导致两类敏感数据同时暴露
//   - 加密用 pgp_sym_encrypt（pgcrypto），AES-128-CFB
//   - 保留期 180 天，由 cron /api/cron/ai-audit-cleanup 删除
//
// 详见 aster-deploy/docs/pm/07-ai-billing.md 的"内容审计"章节

import { sql } from 'drizzle-orm';
import { db } from '@/lib/prisma';

/** 每个 isolate 只报一次「密钥未配置」，避免每笔用量记录刷屏。 */
let missingSecretReported = false;

/** 测试用：重置「已报告」标记。 */
export function resetAuditVaultWarningForTests(): void {
  missingSecretReported = false;
}

/**
 * 审计密钥是否可用（存在且 ≥16 字符，与 encryptionSecret 同一判定）。
 * 不可用时打一次 error 日志：调用方传 null 明文时不会走到加密，若不在这里自检，
 * 生产缺密钥会一直无人察觉，直到 GDPR 导出才暴露。
 */
function auditSecretConfigured(): boolean {
  const secret = process.env.AI_AUDIT_ENCRYPTION_SECRET;
  const ok = !!secret && secret.length >= 16;
  if (!ok && !missingSecretReported) {
    missingSecretReported = true;
    console.error(
      '[ai-audit-vault] AI_AUDIT_ENCRYPTION_SECRET missing or too short (>=16 chars): ' +
        'AI prompt/completion audit records cannot be encrypted and the GDPR export omits their original text',
    );
  }
  return ok;
}

function encryptionSecret(): string {
  const secret = process.env.AI_AUDIT_ENCRYPTION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('AI_AUDIT_ENCRYPTION_SECRET missing or too short (>=16 chars)');
  }
  return secret;
}

/**
 * 把明文 prompt/completion 转换成 pgcrypto 加密表达式
 *
 * 用法（在 INSERT 的 values 里）：
 *   await db.insert(aiUsageRecords).values({
 *     ...
 *     encryptedPrompt: encryptForAudit('user prompt text'),
 *   })
 *
 * 注意：返回 SQL 表达式而非字符串，drizzle 会原样插入。
 */
export function encryptForAudit(plaintext: string | null | undefined) {
  // 先做配置自检（只记日志，不改变下面的加密/抛错行为）。
  auditSecretConfigured();
  if (plaintext == null) return null;
  const secret = encryptionSecret();
  return sql`pgp_sym_encrypt(${plaintext}, ${secret})`;
}

/**
 * 解密单条记录（管理员调取/合规导出/用户申诉用）
 * 不暴露给普通业务路径
 */
export async function decryptAuditField(
  encryptedValue: string
): Promise<string | null> {
  const secret = encryptionSecret();
  const result = await db.execute(sql`
    SELECT pgp_sym_decrypt(${encryptedValue}::bytea, ${secret}::text) AS plain
  `);
  const rows = result as unknown as Array<{ plain: string | null }>;
  return rows[0]?.plain ?? null;
}
