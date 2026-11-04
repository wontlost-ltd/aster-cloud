/**
 * 回跳入口统一走 safe-redirect（#695）的源码一致性断言。
 *
 * login-content.tsx 整体渲染要拉起 next-auth / Turnstile / next-intl 整条依赖链，
 * auth.ts 的 NextAuth 配置也不便在单测里实例化；判定本身已由 safe-redirect.test.ts 的
 * 恶意样本表覆盖，这里只锁定「这些入口确实调用了共用判定、没有退回原样跳转」。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (rel: string) => readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

describe('回跳入口统一使用 safeRedirectPath / resolveAuthRedirect', () => {
  it('登录页：callbackUrl 先经 safeRedirectPath，再用于跳转与注册链接', () => {
    const src = read('app/[locale]/(auth)/login/login-content.tsx');
    expect(src).toMatch(/safeRedirectPath\(\s*searchParams\.get\('callbackUrl'\)/);
    // 登录成功后的兜底跳转也不能原样使用 result.url
    expect(src).not.toMatch(/window\.location\.href\s*=\s*result\.url/);
  });

  it('注册页：returnTo 经 safeRedirectPath，不再手写前缀判断', () => {
    const src = read('app/[locale]/(auth)/signup/signup-content.tsx');
    expect(src).toMatch(/safeRedirectPath\(returnTo/);
    expect(src).not.toMatch(/startsWith\('\/\/'\)/);
  });

  it('Auth.js：配置了 redirect 回调并委托 resolveAuthRedirect', () => {
    const src = read('auth.ts');
    expect(src).toMatch(/redirect\(\s*params\s*\)\s*\{[^}]*resolveAuthRedirect\(params\)/);
  });
});
