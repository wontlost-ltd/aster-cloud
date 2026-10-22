import { describe, it, expect } from 'vitest';
import { isByokKeyExpired } from '@/lib/byok-expiry';

/** BYOK 失效判定（F13）：设置页徽标与推理选择层共用，口径 expiresAt <= now。 */
describe('isByokKeyExpired', () => {
  const now = Date.parse('2026-10-22T12:00:00Z');

  it('未设置失效日期 → 永不过期', () => {
    expect(isByokKeyExpired(null, now)).toBe(false);
    expect(isByokKeyExpired(undefined, now)).toBe(false);
  });

  it('过去的日期 → 已失效（ISO 字符串与 Date 同口径）', () => {
    expect(isByokKeyExpired('2026-08-01T00:00:00.000Z', now)).toBe(true);
    expect(isByokKeyExpired(new Date('2026-08-01T00:00:00Z'), now)).toBe(true);
  });

  it('恰好等于 now → 已失效（与推理层 <= 一致）', () => {
    expect(isByokKeyExpired(new Date(now), now)).toBe(true);
  });

  it('未来日期 → 未失效', () => {
    expect(isByokKeyExpired('2026-10-23T00:00:00.000Z', now)).toBe(false);
  });

  it('无法解析的日期不判死', () => {
    expect(isByokKeyExpired('not-a-date', now)).toBe(false);
  });
});
