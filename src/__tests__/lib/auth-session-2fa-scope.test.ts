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

// ★两条原本在这里的源码文本断言（"第二因子在密码之后"、"验证码失败不计入
//   账户锁定"）已被删除——不是放弃，而是**升级**：编排逻辑抽到
//   lib/auth/authorize-credentials.ts 之后，这两条已由
//   __tests__/lib/authorize-credentials.test.ts 用**行为断言**覆盖
//   （注入 spy，断言 recordFailedAttempt 未被调用、密码错时不发信）。
//   源码文本断言对"标记全在、行为全没了"的变异无能——审查已实证。
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

});
