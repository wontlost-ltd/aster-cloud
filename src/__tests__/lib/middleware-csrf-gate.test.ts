// CSRF 网关测试（审计 #168）——针对 applyCsrfGate 纯函数（middleware 顶部对 /api 调用它）。
//
// 钉住：①跨站 cookie 变更 → 403 ②同源 → 放行 ③安全方法 → 放行 ④Bearer → 放行
// ⑤豁免前缀（internal/auth/cron/telemetry/dsar/stripe-webhook/csp-report/playground/renew）→ 放行
// ⑥★不整体豁免 /api/v1：cookie-auth 的 v1 子路由（domain-vocabularies/versions）
//   跨站 → 403 ⑦前缀边界（/api/authz 不被 /api/auth 误豁免）⑧stripe/checkout 非 webhook 需 CSRF。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyCsrfGate, isCsrfExempt } from '@/lib/security/csrf-gate';

const ORIGIN = 'https://aster-lang.cloud';
const env = process.env as Record<string, string | undefined>;
let savedOrigins: string | undefined;
let savedNodeEnv: string | undefined;

beforeAll(() => {
  savedOrigins = env.CSRF_ALLOWED_ORIGINS;
  savedNodeEnv = env.NODE_ENV;
  env.CSRF_ALLOWED_ORIGINS = ORIGIN;
  env.NODE_ENV = 'production'; // fail-closed 语义（无 Origin → 拒）
});
afterAll(() => {
  if (savedOrigins === undefined) delete env.CSRF_ALLOWED_ORIGINS; else env.CSRF_ALLOWED_ORIGINS = savedOrigins;
  env.NODE_ENV = savedNodeEnv;
});

function req(path: string, method: string, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${path}`, { method, headers });
}
/** 拒绝返回 403 response，放行返回 null → 归一为状态码/null。 */
function gate(path: string, method: string, headers: Record<string, string> = {}) {
  const r = applyCsrfGate(req(path, method, headers));
  return r === null ? 'PASS' : r.status;
}

describe('applyCsrfGate — 中间件 CSRF 网关（审计 #168）', () => {
  it('跨站 cookie 变更请求 → 403（无 Origin）', () => {
    expect(gate('/api/policies', 'POST')).toBe(403);
  });
  it('跨站 cookie 变更请求 → 403（Origin 不在白名单）', () => {
    expect(gate('/api/policies', 'POST', { origin: 'https://evil.example' })).toBe(403);
  });
  it('同源 cookie 变更请求 → 放行', () => {
    expect(gate('/api/policies', 'POST', { origin: ORIGIN })).toBe('PASS');
  });
  it('同源 Referer（无 Origin 头）→ 放行', () => {
    expect(gate('/api/policies', 'POST', { referer: `${ORIGIN}/policies/new` })).toBe('PASS');
  });
  it('安全方法（GET/HEAD/OPTIONS）无论 Origin → 放行', () => {
    expect(gate('/api/policies', 'GET')).toBe('PASS');
    expect(gate('/api/policies', 'HEAD')).toBe('PASS');
    expect(gate('/api/policies', 'OPTIONS')).toBe('PASS');
  });
  it('Bearer-token（v1 API-key / cron）→ checkCsrf 内置豁免放行', () => {
    expect(gate('/api/v1/policies', 'POST', { authorization: 'Bearer key_abc' })).toBe('PASS');
    expect(gate('/api/v1/policies/p1/execute', 'POST', { authorization: 'Bearer key_abc' })).toBe('PASS');
  });
  it('豁免前缀无 Origin 也放行（S2S/NextAuth/公开）', () => {
    for (const p of [
      '/api/internal/apikey/verify',
      '/api/auth/forgot-password',
      '/api/auth/[...nextauth]',
      '/api/cron/user-purge',
      '/api/stripe/webhook',
      '/api/v1/telemetry',
      '/api/v1/dsar',
      '/api/csp-report',
      '/api/playground/evaluate-source',
      '/api/renew/tok123/checkout',
    ]) {
      expect(gate(p, 'POST'), `${p} should be exempt`).toBe('PASS');
    }
  });
  it('★不整体豁免 /api/v1：cookie-auth 的 v1 子路由跨站 → 403', () => {
    expect(gate('/api/v1/domain-vocabularies/terms', 'POST')).toBe(403);
    expect(gate('/api/v1/policies/p1/versions', 'POST')).toBe(403);
    // 同源应放行
    expect(gate('/api/v1/policies/p1/versions', 'POST', { origin: ORIGIN })).toBe('PASS');
  });
  it('stripe/checkout（cookie-auth，非 webhook）跨站 → 403', () => {
    expect(gate('/api/stripe/checkout', 'POST')).toBe(403);
  });
  it('前缀边界：/api/authz-fake 不被 /api/auth 豁免误放', () => {
    expect(isCsrfExempt('/api/authz-fake')).toBe(false);
    expect(gate('/api/authz-fake', 'POST')).toBe(403);
    // 精确豁免命中
    expect(isCsrfExempt('/api/auth')).toBe(true);
    expect(isCsrfExempt('/api/auth/forgot-password')).toBe(true);
  });
  it('非 /api 路径 → 网关不介入（返回 null）', () => {
    expect(applyCsrfGate(req('/dashboard', 'POST'))).toBeNull();
  });
  describe('AI 工作台服务调用 /api/llm/*（ADR 0049 Part B）', () => {
    const SVC = { 'x-internal-caller': 'ai-workspace' };
    it('带 X-Internal-Caller: ai-workspace 的 /api/llm/* 变更请求无 Origin 也放行（路由自行验签）', () => {
      for (const p of ['/api/llm/suggest', '/api/llm/generate', '/api/llm/assistant', '/api/llm/complete']) {
        expect(gate(p, 'POST', SVC), `${p} should pass`).toBe('PASS');
      }
    });
    it('★/api/llm/* 的 cookie 变更请求（无服务头、无 Origin）仍 → 403', () => {
      expect(gate('/api/llm/suggest', 'POST')).toBe(403);
      expect(gate('/api/llm/suggest', 'POST', { 'x-internal-caller': 'cloud-bff' })).toBe(403);
    });
    it('★服务头只在 /api/llm/* 生效：其它路径照旧 403', () => {
      expect(gate('/api/policies', 'POST', SVC)).toBe(403);
      expect(gate('/api/llmx/suggest', 'POST', SVC)).toBe(403);
      expect(gate('/api/llm', 'POST', SVC)).toBe(403);
    });
  });
});
