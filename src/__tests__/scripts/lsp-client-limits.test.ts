/**
 * LSP 网关按客户端限流（lsp-server.mjs）。
 *
 * lsp.aster-lang.dev 的 Cloudflare tunnel 直连 aster-lsp Service、不经 Traefik，入口中间件不会生效，
 * 故按 IP 的限制必须在网关进程内做。Service 是 ClusterIP、只有 cloudflared 能到达，CF-Connecting-IP 可信。
 * 前端 bundle 内联 NEXT_PUBLIC_LSP_TOKEN 后共享 token 公开，每个会话又 spawn 一个约 80 MiB 的子进程，
 * 需要：单 IP 并发会话上限、单 IP 握手速率（令牌桶）、子进程堆上限。
 */
import { describe, it, expect } from 'vitest';
import { childNodeArgs, clientKey, createClientLimiter } from '../../../lsp-server.mjs';

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

describe('clientKey', () => {
  it('优先 CF-Connecting-IP（去空白）', () => {
    expect(clientKey({ 'cf-connecting-ip': ' 203.0.113.9 ' }, '10.0.0.5')).toBe('203.0.113.9');
  });
  it('缺失时回退到对端地址（本地开发）', () => {
    expect(clientKey({}, '127.0.0.1')).toBe('127.0.0.1');
    expect(clientKey({ 'cf-connecting-ip': '' }, undefined)).toBe('unknown');
  });
});

describe('childNodeArgs', () => {
  it('★子进程带 --max-old-space-size=128', () => {
    expect(childNodeArgs('/app/server.js')).toEqual(['--max-old-space-size=128', '/app/server.js', '--stdio']);
  });
});
