/**
 * 演示 layout 的保存校验契约（ADR 0058 §7.5 末段）：两个演示的 layout 必须能过包里的
 * `validatePolicyLayout`——与 cloud 保存策略版本时用的是同一实现，演示不是例外。
 *
 * 《孤勇》另外按「真实策略」的口径再校验一遍：词法表取服务端 `getLexicon('zh-CN')`，
 * 关键词别名作为冻结的 aliasSet 传入；去掉 aliasSet 时必须被 `layout_structural_hides_value`
 * 拒绝——证明「结构 span 不得隐藏值」这条规则在 cloud 侧真的生效。
 */
import { describe, it, expect } from 'vitest';
import { validatePolicyLayout } from '@aster-cloud/aster-lang-ts/layout';
import { POEMS } from '@/config/poem-demo';
import { GUYONG } from '@/config/guyong-demo';
import { getLexicon } from '@/lib/aster-lexicon';

/** 演示词法表的别名（kind → 只读别名列表）转成 validatePolicyLayout 要的冻结 aliasSet 形态。 */
function frozenAliasSet(aliases: Readonly<Record<string, readonly string[]>> | undefined): Record<string, string[]> {
  return Object.fromEntries(Object.entries(aliases ?? {}).map(([kind, words]) => [kind, [...words]]));
}

describe('演示 layout 通过 validatePolicyLayout', () => {
  it('jingyesi demo layout passes validatePolicyLayout with its own lexicon', () => {
    const poem = POEMS.zh;
    expect(poem.layout).toBeDefined();
    expect(validatePolicyLayout(poem.layout!, poem.source, poem.lexicon)).toEqual({ ok: true });
  });

  it('each guyong variant passes with GUYONG.lexicon', () => {
    for (const v of GUYONG.variants) {
      expect(validatePolicyLayout(GUYONG.layoutFor(v), GUYONG.sourceFor(v), GUYONG.lexicon), v.trigger).toEqual({
        ok: true,
      });
    }
  });

  it('each guyong variant passes as a real policy would be checked (ZH_CN + frozen aliasSet)', () => {
    const aliasSet = frozenAliasSet(GUYONG.lexicon.aliases);
    for (const v of GUYONG.variants) {
      expect(
        validatePolicyLayout(GUYONG.layoutFor(v), GUYONG.sourceFor(v), getLexicon('zh-CN'), aliasSet),
        v.trigger,
      ).toEqual({ ok: true });
    }
  });

  it('guyong fails without the aliasSet', () => {
    for (const v of GUYONG.variants) {
      const result = validatePolicyLayout(GUYONG.layoutFor(v), GUYONG.sourceFor(v), getLexicon('zh-CN'));
      expect(result.ok, v.trigger).toBe(false);
      expect(result.ok === false && result.code, v.trigger).toBe('layout_structural_hides_value');
    }
  });
});
