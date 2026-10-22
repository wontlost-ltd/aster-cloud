import { describe, it, expect, vi } from 'vitest';
import { generateSlug, randomSlugSuffix, validateSlug } from '@/lib/validation';

/**
 * 团队 slug 自动生成（F9）。
 *
 * 缺陷：旧实现把 CJK 字符保留在 slug 里（"E2E-测试团队" → "e2e-测试团队"），
 * 既不满足输入框自己的 pattern，也过不了服务端 validateSlug，用户只能手改。
 * 这里钉死一条不变式：**自动生成的 slug 一定能通过服务端校验**。
 */
describe('generateSlug', () => {
  const SUFFIX = 'abc123';

  it.each([
    ['E2E-测试团队', 'e2e'],
    ['Risk Control', 'risk-control'],
    ['Café Crème', 'cafe-creme'],
    ['ＡＢＣ　１２３', 'abc-123'],
    ['  --Ops__Team--  ', 'ops-team'],
    ['风控 Team 2', 'team-2'],
  ])('%s → %s', (name, expected) => {
    expect(generateSlug(name, SUFFIX)).toBe(expected);
  });

  it('剔除非 ASCII 后不足 2 个字符时回落到 team-<suffix>', () => {
    expect(generateSlug('测试团队', SUFFIX)).toBe('team-abc123');
    expect(generateSlug('टीम', SUFFIX)).toBe('team-abc123');
    expect(generateSlug('A 团队', SUFFIX)).toBe('team-abc123');
  });

  it('ß 按德语惯例写作 ss，而不是被当成分隔符', () => {
    expect(generateSlug('Straße', 'abc123')).toBe('strasse');
  });

  it('截断到 50 字符后不留尾部连字符', () => {
    const slug = generateSlug(`${'a'.repeat(49)} b`, SUFFIX);
    expect(slug).toBe('a'.repeat(49));
  });

  it.each(['E2E-测试团队', '测试团队', 'Café Crème', '!!!', `${'x'.repeat(49)}-y`, 'a--b'])(
    '生成结果总能通过 validateSlug：%s',
    (name) => {
      expect(validateSlug(generateSlug(name, randomSlugSuffix())).valid).toBe(true);
    },
  );
});

describe('randomSlugSuffix', () => {
  it('是 6 位小写字母数字', () => {
    expect(randomSlugSuffix()).toMatch(/^[a-z0-9]{6}$/);
  });

  it('★非安全上下文（无 crypto.randomUUID，如内网 http）也能生成', () => {
    const original = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: original.getRandomValues.bind(original) });
    try {
      expect(randomSlugSuffix()).toMatch(/^[a-z0-9]{6}$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
