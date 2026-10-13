/**
 * checkAndRecordNonce / claimNonce 对唯一约束冲突的判定（#480）。
 *
 * drizzle 把 23505 包在 cause 上；此前只看顶层 code，重放时直接抛错（secure-executor 返回 500
 * 而非 ALREADY_USED）。真 Postgres 行为见 internal-nonce-replay.saas.integration.test.ts。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { values } = vi.hoisted(() => ({ values: vi.fn() }));
vi.mock('@/lib/prisma', () => ({
  db: { insert: () => ({ values }) },
  usedNonces: {},
}));

import { checkAndRecordNonce, claimNonce } from '@/services/security/nonce-service';

const duplicate = () =>
  Object.assign(new Error('Failed query'), {
    cause: Object.assign(new Error('duplicate key'), { code: '23505' }),
  });

const UUID = '3f1c2a4b-5d6e-4f70-8a91-b2c3d4e5f607';

beforeEach(() => values.mockReset());

describe('nonce-service 唯一约束冲突', () => {
  it('★checkAndRecordNonce：drizzle 包装的 23505 → ALREADY_USED，而不是抛错', async () => {
    values.mockRejectedValueOnce(duplicate());
    await expect(checkAndRecordNonce(UUID)).resolves.toEqual({ valid: false, reason: 'ALREADY_USED' });
  });

  it('★claimNonce：drizzle 包装的 23505 → false', async () => {
    values.mockRejectedValueOnce(duplicate());
    await expect(claimNonce('n-1', new Date())).resolves.toBe(false);
  });

  it('首次写入成功 → true', async () => {
    values.mockResolvedValueOnce(undefined);
    await expect(claimNonce('n-1', new Date())).resolves.toBe(true);
  });

  it('其它数据库错误照常抛出（由调用方 fail-closed）', async () => {
    values.mockRejectedValueOnce(Object.assign(new Error('conn'), { cause: { code: '08006' } }));
    await expect(claimNonce('n-1', new Date())).rejects.toThrow('conn');
  });

  it('nonce 长度越界直接拒绝，不写表', async () => {
    await expect(claimNonce('', new Date())).rejects.toThrow();
    await expect(claimNonce('x'.repeat(129), new Date())).rejects.toThrow();
    expect(values).not.toHaveBeenCalled();
  });
});
