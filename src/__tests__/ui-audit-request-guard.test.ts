/** UI 审计（#774）按钮探测请求闸门：写请求、API 读请求、有副作用的页面一律拦截，页面与静态资源放行。 */
import { describe, expect, it } from 'vitest';
import { classifyRequest } from './e2e-browser/ui-audit/request-guard';

const B = 'http://localhost:3774';

describe('ui-audit request guard', () => {
  it('blocks every write method', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(classifyRequest(m, `${B}/en/dashboard`)).toBe('block-write');
  });

  it('blocks API reads on any origin, including aster-api', () => {
    expect(classifyRequest('GET', `${B}/api/user/api-usage`)).toBe('block-read');
    expect(classifyRequest('GET', 'http://localhost:8774/api/v1/lexicons')).toBe('block-read');
    expect(classifyRequest('GET', `${B}/api/auth/signout`)).toBe('block-read');
  });

  it('blocks pages whose GET changes state', () => {
    for (const p of ['/logout', '/zh/logout', '/en/verify-email?token=x', '/reset-password', '/teams/invite?token=x', '/renew/abc']) {
      expect(classifyRequest('GET', `${B}${p}`)).toBe('block-read');
    }
  });

  it('allows ordinary pages, RSC payloads and static assets', () => {
    expect(classifyRequest('GET', `${B}/en/policies?_rsc=1`)).toBe('allow');
    expect(classifyRequest('GET', `${B}/_next/static/chunks/app.js`)).toBe('allow');
    expect(classifyRequest('HEAD', `${B}/en/docs`)).toBe('allow');
    expect(classifyRequest('GET', `${B}/en/teams/ui-audit-team`)).toBe('allow');
  });
});
