/**
 * LSP 网关按客户端限流（lsp-server.mjs）。
 *
 * lsp.aster-lang.dev 的 Cloudflare tunnel 直连 aster-lsp Service、不经 Traefik，入口中间件不会生效，
 * 故按 IP 的限制必须在网关进程内做。Service 是 ClusterIP、只有 cloudflared 能到达，CF-Connecting-IP 可信。
 * 前端 bundle 内联 NEXT_PUBLIC_LSP_TOKEN 后共享 token 公开，每个会话又 spawn 一个约 80 MiB 的子进程，
 * 需要：单 IP 并发会话上限、单 IP 握手速率（令牌桶）、子进程堆上限。
 */
import { describe, it, expect } from 'vitest';
import { childNodeArgs, clientIdentity, createClientLimiter, createThrottledWarner, normalizeClientIp } from '../../../lsp-server.mjs';

const limits = (now: () => number) => createClientLimiter({ maxSessionsPerClient: 3, ratePerMinute: 6, burst: 10, now });

describe('createClientLimiter — 单 IP 并发会话', () => {
  it('★同一 IP 第 4 个会话被拒（429），释放一个后可再连', () => {
    const l = limits(() => 0);
    for (let i = 0; i < 3; i++) expect(l.acquire('1.1.1.1')).toEqual({ ok: true });
    expect(l.acquire('1.1.1.1')).toEqual({ ok: false, code: 429, reason: 'Too many sessions from this client' });
    l.release('1.1.1.1');
    expect(l.acquire('1.1.1.1')).toEqual({ ok: true });
  });

  it('不同 IP 互不影响', () => {
    const l = limits(() => 0);
    for (let i = 0; i < 3; i++) l.acquire('1.1.1.1');
    expect(l.acquire('2.2.2.2')).toEqual({ ok: true });
  });

  it('多余的 release 不会让计数变负', () => {
    const l = limits(() => 0);
    l.release('1.1.1.1');
    for (let i = 0; i < 3; i++) expect(l.acquire('1.1.1.1').ok).toBe(true);
    expect(l.acquire('1.1.1.1').ok).toBe(false);
  });
});

describe('createClientLimiter — 缺头共享桶', () => {
  it('会话上限放宽到全局上限，但仍受（放大的）握手速率限制', () => {
    const l = createClientLimiter({ maxSessionsPerClient: 6, ratePerMinute: 60, burst: 100, now: () => 0 });
    for (let i = 0; i < 6; i++) expect(l.acquire('no-cf-connecting-ip').ok).toBe(true);
    expect(l.acquire('no-cf-connecting-ip')).toMatchObject({ ok: false, reason: 'Too many sessions from this client' });
  });
});

describe('createClientLimiter — 握手速率（令牌桶：突发 10，平均 6/分钟）', () => {
  it('★突发 10 次后第 11 次被拒（429，带 retryAfterSeconds）', () => {
    const l = limits(() => 0);
    for (let i = 0; i < 10; i++) {
      expect(l.acquire('1.1.1.1').ok).toBe(true);
      l.release('1.1.1.1');
    }
    expect(l.acquire('1.1.1.1')).toEqual({ ok: false, code: 429, reason: 'Rate limit exceeded', retryAfterSeconds: 10 });
  });

  it('按 6/分钟补充：10 秒后恢复 1 次', () => {
    let t = 0;
    const l = limits(() => t);
    for (let i = 0; i < 10; i++) { l.acquire('1.1.1.1'); l.release('1.1.1.1'); }
    expect(l.acquire('1.1.1.1').ok).toBe(false);
    t = 10_000;
    expect(l.acquire('1.1.1.1').ok).toBe(true);
  });

  it('空闲条目被回收（令牌满且无会话）', () => {
    let t = 0;
    const l = limits(() => t);
    l.acquire('1.1.1.1'); l.release('1.1.1.1');
    t = 10 * 60_000;
    l.acquire('2.2.2.2');
    expect(l.size()).toBe(1);
  });
});

describe('normalizeClientIp', () => {
  it('IPv4 按完整地址', () => {
    expect(normalizeClientIp('203.0.113.9')).toBe('203.0.113.9');
  });
  it('★IPv4-mapped IPv6 按其中的 IPv4 完整地址', () => {
    expect(normalizeClientIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeClientIp('::FFFF:1.2.3.4')).toBe('1.2.3.4');
  });
  it('★IPv6 按 /64 前缀：同 /64 的不同地址得到同一个键', () => {
    const a = normalizeClientIp('2001:db8:abcd:12:1::1');
    const b = normalizeClientIp('2001:0db8:abcd:0012:ffff:eeee:dddd:cccc');
    expect(a).toBe('2001:db8:abcd:12::/64');
    expect(b).toBe(a);
    expect(normalizeClientIp('2001:db8:abcd:13::1')).not.toBe(a);
  });
  it('IPv6 缩写在前 4 组内（::）也能正确展开', () => {
    expect(normalizeClientIp('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(normalizeClientIp('::1')).toBe('0:0:0:0::/64');
  });
  it('去掉 zone id 与方括号', () => {
    expect(normalizeClientIp('[fe80::1%eth0]')).toBe('fe80:0:0:0::/64');
  });
});

describe('clientIdentity', () => {
  it('优先 CF-Connecting-IP（去空白、按前缀归一）', () => {
    expect(clientIdentity({ 'cf-connecting-ip': ' 2001:db8:1:2::9 ' }, '10.0.0.5', true))
      .toEqual({ key: '2001:db8:1:2::/64', missingHeader: false });
  });
  it('★生产环境缺头：归入单独的共享桶，并标记 missingHeader（不按对端地址合并）', () => {
    expect(clientIdentity({}, '10.42.0.7', true)).toEqual({ key: 'no-cf-connecting-ip', missingHeader: true });
    expect(clientIdentity({ 'cf-connecting-ip': '  ' }, '10.42.0.7', true)).toEqual({ key: 'no-cf-connecting-ip', missingHeader: true });
  });
  it('非生产（本地开发）缺头：按对端地址', () => {
    expect(clientIdentity({}, '::ffff:127.0.0.1', false)).toEqual({ key: '127.0.0.1', missingHeader: false });
    expect(clientIdentity({}, undefined, false)).toEqual({ key: 'unknown', missingHeader: false });
  });
});

describe('createThrottledWarner', () => {
  it('★首次立即告警，节流窗口内只记一次，窗口过后再记一次并带累计次数', () => {
    let t = 0;
    const logs: string[] = [];
    const warn = createThrottledWarner({ intervalMs: 60_000, now: () => t, log: (m: string) => logs.push(m), message: 'missing CF-Connecting-IP' });
    warn(); warn(); warn();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('missing CF-Connecting-IP');
    t = 59_999; warn();
    expect(logs).toHaveLength(1);
    t = 60_000; warn();
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain('5 times');
  });
});

describe('childNodeArgs', () => {
  it('★子进程带 --max-old-space-size=128', () => {
    expect(childNodeArgs('/app/server.js')).toEqual(['--max-old-space-size=128', '/app/server.js', '--stdio']);
  });
});
