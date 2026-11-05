/**
 * 站内回跳校验（#695）：login / signup / 409 入口 / Auth.js redirect 回调共用的唯一判定。
 * 用一张恶意样本表锁定「只放行同源站内路径」：任何能让浏览器离开本站的写法都必须回落到默认页。
 */
import { describe, it, expect } from 'vitest';
import { safeRedirectPath, resolveAuthRedirect } from '@/lib/safe-redirect';

const ORIGIN = 'https://cloud.example';
const FALLBACK = '/dashboard';

describe('safeRedirectPath — 放行站内路径', () => {
  it.each([
    ['/dashboard', '/dashboard'],
    ['/en/teams/invite?token=abc', '/en/teams/invite?token=abc'],
    ['/zh/policies/1#rules', '/zh/policies/1#rules'],
    ['/', '/'],
    ['/a/../b', '/b'],
    ['/@evil.com', '/@evil.com'],
    ['/%2F%2Fevil.com', '/%2F%2Fevil.com'],
    ['/en/docs?next=https://evil.com', '/en/docs?next=https://evil.com'],
  ])('%s → %s', (raw, expected) => {
    expect(safeRedirectPath(raw, FALLBACK, ORIGIN)).toBe(expected);
  });

  it('同源绝对地址按路径放行（如 AI 工作台交接带回的完整地址）', () => {
    expect(safeRedirectPath(`${ORIGIN}/api/ai-workspace/handoff?next=%2F`, FALLBACK, ORIGIN)).toBe(
      '/api/ai-workspace/handoff?next=%2F',
    );
  });

  it('不给站点 origin 时只接受相对路径，绝对地址一律回落', () => {
    expect(safeRedirectPath('/en/onboarding', FALLBACK)).toBe('/en/onboarding');
    expect(safeRedirectPath(`${ORIGIN}/dashboard`, FALLBACK)).toBe(FALLBACK);
  });
});

describe('safeRedirectPath — 恶意样本一律回落默认页', () => {
  const malicious: Array<[string, unknown]> = [
    ['反斜杠（#695 原始绕过）', '/\\evil.com'],
    ['双反斜杠', '\\\\evil.com'],
    ['反斜杠混正斜杠', '\\/evil.com'],
    ['路径中段反斜杠', '/foo\\..\\..\\\\evil.com'],
    ['协议相对', '//evil.com'],
    ['协议相对带路径', '//evil.com/dashboard'],
    ['三斜杠', '///evil.com'],
    ['点段归一后变协议相对', '/.//evil.com'],
    ['上跳归一后变协议相对', '/a/..//evil.com'],
    ['绝对外站', 'https://evil.com'],
    ['大小写协议外站', 'HTTPS://evil.com/x'],
    ['只差端口', 'https://cloud.example:8443/x'],
    ['只差协议', 'http://cloud.example/x'],
    ['userinfo 伪装本站', 'https://cloud.example@evil.com/'],
    ['子域伪装本站', 'https://cloud.example.evil.com/'],
    ['javascript 伪协议', 'javascript:alert(1)'],
    ['大小写 javascript', 'JaVaScRiPt:alert(1)'],
    ['前导空白 javascript', ' javascript:alert(1)'],
    ['data URL', 'data:text/html,<script>alert(1)</script>'],
    ['vbscript', 'vbscript:msgbox(1)'],
    ['无斜杠 scheme', 'https:evil.com'],
    ['制表符拆开的协议相对', '/\t/evil.com'],
    ['换行拆开的协议相对', '/\n/evil.com'],
    ['回车', '/\r/evil.com'],
    ['NUL', '/\u0000/evil.com'],
    ['DEL', '/\u007f/evil.com'],
    ['前导空格协议相对', ' //evil.com'],
    ['不换行空格（NBSP）前缀', '\u00A0//evil.com'],
    ['零宽空格前缀', '\u200B//evil.com'],
    ['BOM 前缀', '\uFEFF//evil.com'],
    ['全角空格前缀', '\u3000//evil.com'],
    ['编码的协议相对（非 / 开头）', '%2F%2Fevil.com'],
    ['相对片段（非 / 开头）', 'evil.com'],
    ['仅查询串', '?x=1'],
    ['空串', ''],
    ['超长输入', `/${'a'.repeat(4096)}`],
    ['非字符串：数字', 42],
    ['非字符串：数组', ['/dashboard']],
    ['null', null],
    ['undefined', undefined],
  ];

  it.each(malicious)('%s', (_label, raw) => {
    expect(safeRedirectPath(raw, FALLBACK, ORIGIN)).toBe(FALLBACK);
  });

  it('回落值可为 null（调用方据此判断「没有可用回跳」）', () => {
    expect(safeRedirectPath('/\\evil.com', null, ORIGIN)).toBeNull();
    expect(safeRedirectPath(null, null, ORIGIN)).toBeNull();
  });

  it('放行的结果永远以单个 / 开头，且不含反斜杠', () => {
    for (const [, raw] of malicious) {
      const out = safeRedirectPath(raw, null, ORIGIN);
      if (out !== null) {
        expect(out.startsWith('/')).toBe(true);
        expect(out.startsWith('//')).toBe(false);
        expect(out.includes('\\')).toBe(false);
      }
    }
  });
});

describe('resolveAuthRedirect — Auth.js redirect 回调', () => {
  const baseUrl = 'https://cloud.example';

  it.each([
    ['/en/onboarding', `${baseUrl}/en/onboarding`],
    ['/', `${baseUrl}/`],
    [`${baseUrl}/dashboard?x=1`, `${baseUrl}/dashboard?x=1`],
  ])('站内 %s → %s', (url, expected) => {
    expect(resolveAuthRedirect({ url, baseUrl })).toBe(expected);
  });

  it.each(['/\\evil.com', '//evil.com', 'https://evil.com/', 'javascript:alert(1)', '/.//evil.com'])(
    '外站 %s → baseUrl',
    (url) => {
      expect(resolveAuthRedirect({ url, baseUrl })).toBe(baseUrl);
    },
  );

  it('baseUrl 带尾斜杠时按 origin 拼接', () => {
    expect(resolveAuthRedirect({ url: '/x', baseUrl: 'https://cloud.example/' })).toBe('https://cloud.example/x');
  });

  it('baseUrl 带 basePath 时只取 origin 拼接站内路径', () => {
    expect(resolveAuthRedirect({ url: '/x', baseUrl: 'https://cloud.example/app' })).toBe('https://cloud.example/x');
  });
});
