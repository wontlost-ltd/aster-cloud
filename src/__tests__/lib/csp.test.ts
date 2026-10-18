// CSP header builder — Phase 3D-1.
//
// Validates the structural contract; actual securityheaders.com scoring is
// a manual sanity check post-deploy.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildCspHeader, securityHeadersOnly } from '@/lib/security/csp';

const NONCE = 'YWJjZGVmZ2hpamtsbW5vcA==';

const env = process.env as Record<string, string | undefined>;

describe('buildCspHeader', () => {
  let savedNodeEnv: string | undefined;
  beforeEach(() => {
    savedNodeEnv = env.NODE_ENV;
  });
  afterEach(() => {
    env.NODE_ENV = savedNodeEnv;
  });

  it('includes the nonce in script-src and style-src', () => {
    env.NODE_ENV = 'production';
    const csp = buildCspHeader(NONCE);
    expect(csp).toContain(`'nonce-${NONCE}'`);
    expect(csp.match(/'nonce-/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('uses strict-dynamic in script-src', () => {
    env.NODE_ENV = 'production';
    const csp = buildCspHeader(NONCE);
    expect(csp).toContain("'strict-dynamic'");
  });

  it("locks frame-ancestors to 'none' (anti-clickjacking)", () => {
    const csp = buildCspHeader(NONCE);
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("locks object-src to 'none' (blocks Flash etc.)", () => {
    const csp = buildCspHeader(NONCE);
    expect(csp).toContain("object-src 'none'");
  });

  it("restricts media-src to exactly 'self' (self-hosted audio only, e.g. guyong demo)", () => {
    const csp = buildCspHeader(NONCE);
    // 精确锁定整条 directive（同 img-src 模式）：仅 'self'，无远程媒体源。防 default-src
    // 未来放宽时连带放宽媒体来源，也防某远程 host 漂进 media-src 仍被弱 toContain 误判通过。
    expect(getDirective(csp, 'media-src')).toBe("media-src 'self'");
  });

  it('allows Stripe origins for payment integration', () => {
    const csp = buildCspHeader(NONCE);
    expect(csp).toContain('https://js.stripe.com');
    expect(csp).toContain('https://api.stripe.com');
  });

  it('allows Mixpanel for analytics', () => {
    const csp = buildCspHeader(NONCE);
    expect(csp).toContain('https://api-js.mixpanel.com');
  });

  it('allowlists Cloudflare Turnstile in script-src and frame-src (#100)', () => {
    const csp = buildCspHeader(NONCE);
    // frame-src 必需（widget iframe）；script-src host 是无 strict-dynamic 浏览器的
    // 兼容 fallback（CSP3 下经 nonce 传播信任加载 api.js）。两处都列白以兜底 + 对齐
    // Cloudflare 官方 CSP 示例。
    const scriptSrc = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('script-src '));
    const frameSrc = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('frame-src '));
    expect(scriptSrc).toContain('https://challenges.cloudflare.com');
    expect(frameSrc).toContain('https://challenges.cloudflare.com');
  });

  it("includes 'unsafe-eval' in dev (HMR) but not prod", () => {
    env.NODE_ENV = 'development';
    const dev = buildCspHeader(NONCE);
    expect(dev).toContain("'unsafe-eval'");

    env.NODE_ENV = 'production';
    const prod = buildCspHeader(NONCE);
    expect(prod).not.toContain("'unsafe-eval'");
  });

  it('emits upgrade-insecure-requests directive', () => {
    const csp = buildCspHeader(NONCE);
    expect(csp).toContain('upgrade-insecure-requests');
  });

  it('does not allow wildcard wss: in connect-src (#98)', () => {
    env.NODE_ENV = 'production';
    const csp = buildCspHeader(NONCE);
    const connectSrc = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('connect-src'));
    expect(connectSrc).toBeDefined();
    // A bare `wss:` token (wildcard) must not be present; scoped wss://host is fine.
    expect(connectSrc!.split(/\s+/)).not.toContain('wss:');
  });

  it('scopes wss connect-src to the known LSP/policy hosts by default', () => {
    env.NODE_ENV = 'production';
    const csp = buildCspHeader(NONCE);
    expect(csp).toContain('wss://lsp.aster-lang.dev');
    expect(csp).toContain('wss://policy.aster-lang.dev');
  });

  // 从 CSP 串里取出某条 directive 的完整 token 行（去掉 directive 名）。
  // 用它把断言锁死在 img-src 上，防止某个 host 漂到别的 directive 还被全局
  // toContain 误判通过（Codex 审查 #98 建议）。
  const getDirective = (csp: string, name: string): string => {
    const found = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith(`${name} `) || d === name);
    expect(found, `directive ${name} present`).toBeDefined();
    return found!;
  };

  it('img-src is the exact tightened allowlist — no wildcard https: (#98)', () => {
    env.NODE_ENV = 'production';
    const csp = buildCspHeader(NONCE);
    const imgSrc = getDirective(csp, 'img-src');
    // 精确锁定整条 directive：self + data: + blob: + 两个 OAuth 头像 origin。
    // 任何新通配（https:）或 host 漂移都会让这条断言失败。
    expect(imgSrc).toBe(
      "img-src 'self' data: blob: https://avatars.githubusercontent.com https://lh3.googleusercontent.com",
    );
    // 显式：裸 https: 通配不得出现在 img-src token 里。
    expect(imgSrc.split(/\s+/)).not.toContain('https:');
  });
});

describe('securityHeadersOnly', () => {
  const headers = securityHeadersOnly();

  it('sets HSTS with 2-year max-age + preload', () => {
    expect(headers['Strict-Transport-Security']).toContain('max-age=63072000');
    expect(headers['Strict-Transport-Security']).toContain('preload');
  });

  it('blocks MIME sniffing', () => {
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('denies framing', () => {
    expect(headers['X-Frame-Options']).toBe('DENY');
  });

  it('referrer policy is strict-origin-when-cross-origin', () => {
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
  });

  it('Permissions-Policy disables high-risk sensors', () => {
    const p = headers['Permissions-Policy'];
    expect(p).toContain('camera=()');
    expect(p).toContain('microphone=()');
    expect(p).toContain('geolocation=()');
  });

  it('opts out of FLoC', () => {
    expect(headers['Permissions-Policy']).toContain('interest-cohort=()');
  });

  it('Cross-Origin-Opener-Policy is same-origin', () => {
    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin');
  });

  it('allows the aster-lang.dev AI Guardian embed in frame-src only', () => {
    const csp = buildCspHeader(NONCE);
    expect(csp).toMatch(/frame-src [^;]*https:\/\/aster-lang\.dev/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
  });
});
