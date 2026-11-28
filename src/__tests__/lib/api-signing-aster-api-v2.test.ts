// @vitest-environment node
/**
 * aster-api v2 签名助手：对共享契约夹具 `signing` 段逐字节验证 canonical 与签名，
 * 夹具须与 aster-api 的副本逐字节相同。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { signAsterApiV2Headers } from '@/lib/api-signing';

const FIXTURE_PATH = join(__dirname, '..', 'fixtures', 'guard-orphan-feed-contract.json');
const raw = readFileSync(FIXTURE_PATH);
const fixture = JSON.parse(raw.toString('utf8')) as {
  signing: { key: string; method: string; path: string; ts: number; nonce: string; body: string; signature: string };
};
/** aster-api origin/main `src/test/resources/guard/orphan-feed-contract.json` 的 sha256。 */
const API_FIXTURE_SHA256 = '182ecd4a383d8d03ce0039aaa6adbd7b38fafb52bfe7ddbbadf4647e34024845';

describe('signAsterApiV2Headers', () => {
  it('fixture sha256 pinned', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(API_FIXTURE_SHA256);
  });

  it('签名与夹具一致', async () => {
    const s = fixture.signing;
    const headers = await signAsterApiV2Headers(s.method, s.path, s.body, s.key, {
      nowSec: s.ts,
      nonce: s.nonce,
    });
    expect(headers).toEqual({
      'X-Aster-Timestamp': String(s.ts),
      'X-Aster-Nonce': s.nonce,
      'X-Aster-Signature': s.signature,
    });
  });

  it('缺省时间戳取当前秒、nonce 为 UUID 且每次不同', async () => {
    const before = Math.floor(Date.now() / 1000);
    const a = await signAsterApiV2Headers('POST', '/p', '{}', 'k');
    const b = await signAsterApiV2Headers('POST', '/p', '{}', 'k');
    const after = Math.floor(Date.now() / 1000);
    expect(Number(a['X-Aster-Timestamp'])).toBeGreaterThanOrEqual(before);
    expect(Number(a['X-Aster-Timestamp'])).toBeLessThanOrEqual(after);
    expect(a['X-Aster-Nonce']).toMatch(/^[0-9a-f-]{36}$/);
    expect(a['X-Aster-Nonce']).not.toBe(b['X-Aster-Nonce']);
    expect(a['X-Aster-Signature']).toMatch(/^[0-9a-f]{64}$/);
  });
});
