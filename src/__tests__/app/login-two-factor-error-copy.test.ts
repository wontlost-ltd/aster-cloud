// 登录页二次验证错误文案的分支映射（issue #400）。
//
// ## 为什么值得单独测
//
// 安全审查发现：`TWO_FACTOR_WINDOW_EXCEEDED` 此前没有专用分支，落进
// `startsWith('TWO_FACTOR_')` 的通配里，显示成「验证码已过期」。
// 用户被限流时看到「已过期」，会立刻点重发再试一次——**正是限流想阻止的行为**。
// 安全上无害（与 EXPIRED 同文案反而更模糊），但把用户推向了错误动作。
//
// ## 断言的是映射函数，不是渲染结果
//
// login-content.tsx 是 client component，整体渲染需要 next-auth / Turnstile /
// next-intl 一整条依赖链。这里把「错误码 → 文案键」这一纯逻辑抽出来对照断言：
// 它正是审查发现的缺陷所在，也是最容易被后续改动悄悄改坏的地方。
// 真实渲染由本地 chrome-devtools 实测覆盖（四语言登录页均已确认文案落地）。

import { describe, it, expect } from 'vitest';

/**
 * 复刻 login-content.tsx 里的分支映射。
 *
 * ★注意：这是**复刻**，不是被测代码本身——复刻型测试有"实现改了、复刻没改，
 * 测试仍绿"的固有风险。故下面额外加一条源码一致性断言，确保两边不漂移。
 */
function errorKeyFor(errorCode: string): string {
  const key = errorCode.replace('TWO_FACTOR_', '');
  return key === 'MISMATCH'
    ? 'twoFactorMismatch'
    : key === 'TOO_MANY_ATTEMPTS'
      ? 'twoFactorTooManyAttempts'
      : key === 'WINDOW_EXCEEDED'
        ? 'twoFactorWindowExceeded'
        : 'twoFactorExpired';
}

describe('登录页二次验证错误文案映射（issue #400）', () => {
  it('★WINDOW_EXCEEDED 必须有独立文案，不得落到"已过期"', () => {
    // 这条就是审查发现的缺陷：修复前它返回 twoFactorExpired。
    expect(errorKeyFor('TWO_FACTOR_WINDOW_EXCEEDED')).toBe('twoFactorWindowExceeded');
    expect(errorKeyFor('TWO_FACTOR_WINDOW_EXCEEDED')).not.toBe('twoFactorExpired');
  });

  it('其余分支保持原样（回归保护）', () => {
    expect(errorKeyFor('TWO_FACTOR_MISMATCH')).toBe('twoFactorMismatch');
    expect(errorKeyFor('TWO_FACTOR_TOO_MANY_ATTEMPTS')).toBe('twoFactorTooManyAttempts');
    expect(errorKeyFor('TWO_FACTOR_EXPIRED')).toBe('twoFactorExpired');
    // NO_CODE 无专用文案，沿用"已过期"——对用户而言后果相同（需要重新获取）。
    expect(errorKeyFor('TWO_FACTOR_NO_CODE')).toBe('twoFactorExpired');
  });

  it('★源码与本文件的复刻保持一致（防复刻漂移）', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(
      join(process.cwd(), 'src/app/[locale]/(auth)/login/login-content.tsx'),
      'utf8',
    );
    // 源码里必须真的存在这个分支——否则本文件的复刻就是自说自话。
    expect(src).toContain("key === 'WINDOW_EXCEEDED'");
    expect(src).toContain('t.errors.twoFactorWindowExceeded');
  });
});
