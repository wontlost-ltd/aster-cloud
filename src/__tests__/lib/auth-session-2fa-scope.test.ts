// 二次验证的**覆盖范围与有效期**（issue #400）。
//
// 这两条不是实现细节，是安全承诺的边界，且都容易被"顺手"改掉：
//   1. session maxAge —— JWT 不可服务端吊销，有效期是唯一的补偿手段；
//      它同时决定二次验证的实际频率。调长会同时削弱两件事。
//   2. OAuth 不经过第二因子 —— 这是有意取舍，但必须**留痕**，
//      否则将来有人会把"本站已启用 2FA"写进合规材料，而对 OAuth 用户不成立。
//
// ## 本文件用源码断言的理由（诚实声明）
//
// `auth.ts` 导出的是构造好的 NextAuth handler，配置对象本身不对外暴露，
// 且 import 它会拉起整条 DB/adapter 依赖链。这里断言的是**配置事实**
// （maxAge 的值、OAuth 边界的留痕是否还在），不冒充验证运行时行为——
// 运行时行为由 two-factor.saas.integration.test.ts 覆盖。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

const SOURCE = readFileSync(join(process.cwd(), 'src/auth.ts'), 'utf8');

describe('二次验证的覆盖范围与 session 有效期（issue #400）', () => {
  it('★session 必须显式设 maxAge——不能退回 Auth.js 默认的 30 天', () => {
    // 未设置时 Auth.js 默认 30 天。JWT 策略下 session 无法服务端吊销：
    // 改密码、发现异常登录、甚至删用户，已签发 token 在过期前都仍有效。
    expect(SOURCE).toMatch(/maxAge:\s*7\s*\*\s*24\s*\*\s*60\s*\*\s*60/);
  });

  it('★session 有效期不得超过 7 天', () => {
    // 用解析出的实际值断言，而不是只看字面量存在——
    // 有人把 7 改成 90 时字面量仍在，但承诺已经变了。
    const m = /maxAge:\s*(\d+)\s*\*\s*24\s*\*\s*60\s*\*\s*60/.exec(SOURCE);
    expect(m, '未找到以「天」表达的 maxAge').toBeTruthy();
    const days = Number(m![1]);
    expect(days).toBeLessThanOrEqual(7);
  });

  it('★OAuth 绕过第二因子这件事必须在源码里留痕', () => {
    // GitHub/Google 不走 authorize()，故不施加二次验证。这是有意取舍，
    // 但若注释被删掉，将来读代码的人会误以为全站都有第二因子——
    // 进而把它写进合规材料。留痕本身就是这条约束的载体。
    expect(SOURCE).toContain('OAuth 路径不经过第二因子');
    expect(SOURCE).toMatch(/密码登录已启用二次验证/);
  });

  it('★第二因子必须挂在 Credentials 的密码校验**之后**', () => {
    // 放在密码校验之前 = 未提供正确密码的人也能触发发信（邮件轰炸放大器）。
    const pwdCheck = SOURCE.indexOf('const isValidPassword');
    const twoFactor = SOURCE.indexOf('TWO_FACTOR_REQUIRED');
    expect(pwdCheck).toBeGreaterThan(0);
    expect(twoFactor).toBeGreaterThan(0);
    expect(pwdCheck, '第二因子早于密码校验——会变成发信放大器').toBeLessThan(twoFactor);
  });

  it('★验证码失败不得调用 recordFailedAttempt（那是密码错误的轴）', () => {
    // 合并两条轴会让攻击者用错误验证码把受害者账户锁死（DoS）——
    // 他只需要知道邮箱，而邮箱不是秘密。
    const idx = SOURCE.indexOf('const verdict = await verifyCode');
    expect(idx).toBeGreaterThan(0);
    // 取验证码校验之后到 return 之间的片段
    const after = SOURCE.slice(idx, SOURCE.indexOf('resetFailedAttempts', idx));
    expect(after).not.toContain('recordFailedAttempt');
  });
});
