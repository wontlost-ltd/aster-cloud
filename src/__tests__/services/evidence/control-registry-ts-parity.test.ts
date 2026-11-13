// 不依赖兄弟仓、在 CI 中必跑：cloud 注册表副本必须与已安装 aster-lang-ts 内置副本深度相等（ADR 0046 §11 D1）。
// 兄弟仓 aster-lang-locales 真相源的比对见 control-registry-parity.test.ts（CI 中跳过）；
// ts 副本本身由 ts 仓的 parity 测试锁定到真相源，故本用例在 CI 中传递地守护 cloud 副本。
import { describe, it, expect } from 'vitest';
import { CONTROLS_REGISTRY } from '@aster-cloud/aster-lang-ts/browser';
import { defaultControlRegistry, requiresVerifiedInputs } from '@/services/evidence/control-registry';

describe('cloud 注册表副本与 aster-lang-ts', () => {
  it('cloud 副本与已安装 aster-lang-ts 的副本深度相等', () => {
    expect(defaultControlRegistry).toEqual(CONTROLS_REGISTRY);
  });
});

describe('requiresVerifiedInputs', () => {
  it('requiresVerifiedInputs 按档案判定', () => {
    expect(requiresVerifiedInputs('eu-ai-act-high-risk')).toBe(false); // 1.2.0
    expect(requiresVerifiedInputs('nope')).toBe(false);
    expect(requiresVerifiedInputs(undefined)).toBe(false);
    const flipped = structuredClone(defaultControlRegistry);
    flipped.profiles.find((p) => p.id === 'eu-ai-act-high-risk')!.requires.verifiedInputs = true;
    expect(requiresVerifiedInputs('eu-ai-act-high-risk', flipped)).toBe(true);
  });

  it('档案 requires 缺 verifiedInputs 键 → false（ADR 0046 §11.6 第 6 条）', () => {
    const legacy = structuredClone(defaultControlRegistry);
    for (const p of legacy.profiles) delete p.requires.verifiedInputs;
    expect(requiresVerifiedInputs('eu-ai-act-high-risk', legacy)).toBe(false);
  });
});
