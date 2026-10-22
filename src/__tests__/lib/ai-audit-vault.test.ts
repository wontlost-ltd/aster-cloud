import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  db: { execute: vi.fn() },
}));

import {
  encryptForAudit,
  decryptAuditField,
  resetAuditVaultWarningForTests,
} from '@/lib/ai-audit-vault';
import { db } from '@/lib/prisma';

describe('ai-audit-vault', () => {
  const originalSecret = process.env.AI_AUDIT_ENCRYPTION_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AI_AUDIT_ENCRYPTION_SECRET = 'test-audit-secret-min-16-chars-len';
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.AI_AUDIT_ENCRYPTION_SECRET;
    else process.env.AI_AUDIT_ENCRYPTION_SECRET = originalSecret;
  });

  describe('encryptForAudit', () => {
    it('null 输入 → 返回 null（不入库）', () => {
      expect(encryptForAudit(null)).toBeNull();
      expect(encryptForAudit(undefined)).toBeNull();
    });

    it('明文 → 返回 SQL 表达式（含 pgp_sym_encrypt）', () => {
      const expr = encryptForAudit('user prompt');
      expect(expr).toBeTruthy();
      // Drizzle SQL chunks: queryChunks 包含 'pgp_sym_encrypt(' 字符串片段
      const serialized = JSON.stringify(expr);
      expect(serialized).toContain('pgp_sym_encrypt');
    });

    it('secret 缺失 → 抛错（防止误存明文）', () => {
      delete process.env.AI_AUDIT_ENCRYPTION_SECRET;
      expect(() => encryptForAudit('x')).toThrow(/AI_AUDIT_ENCRYPTION_SECRET/);
    });

    it('secret 太短 → 抛错', () => {
      process.env.AI_AUDIT_ENCRYPTION_SECRET = 'short';
      expect(() => encryptForAudit('x')).toThrow(/too short/);
    });

    // F24：调用方几乎总是传 null 明文，此前根本不读密钥——生产缺密钥长期静默。
    it('★secret 缺失时即使明文为 null 也记一次 error 日志（每个 isolate 只记一次），返回值不变', () => {
      delete process.env.AI_AUDIT_ENCRYPTION_SECRET;
      resetAuditVaultWarningForTests();
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(encryptForAudit(null)).toBeNull();
      expect(encryptForAudit(undefined)).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0][0])).toContain('AI_AUDIT_ENCRYPTION_SECRET');
      spy.mockRestore();
    });

    it('secret 正常时不记日志', () => {
      resetAuditVaultWarningForTests();
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      encryptForAudit(null);
      encryptForAudit('x');
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe('decryptAuditField', () => {
    it('返回 db 解密的明文', async () => {
      vi.mocked(db.execute).mockResolvedValue([{ plain: 'decrypted-text' }] as never);
      const result = await decryptAuditField('encrypted-blob');
      expect(result).toBe('decrypted-text');
    });

    it('空结果 → 返回 null', async () => {
      vi.mocked(db.execute).mockResolvedValue([] as never);
      const result = await decryptAuditField('blob');
      expect(result).toBeNull();
    });
  });
});
