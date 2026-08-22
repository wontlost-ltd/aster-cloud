/**
 * R21-Critical-2：requireCronAuth helper 鉴权回归测试。
 *
 * 防回归核心点：
 *   1. NODE_ENV=production 且 CRON_SECRET 缺失 → 503（fail-closed）
 *   2. NODE_ENV!=production 且 CRON_SECRET 缺失 → 放行 + console.warn（dev 体验）
 *   3. CRON_SECRET 配齐但 Authorization 不匹配 → 401
 *   4. CRON_SECRET 配齐且 Authorization 匹配 → 放行
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { requireCronAuth } from '@/lib/cron-auth';

function makeRequest(authHeader?: string): NextRequest {
  const headers = new Headers();
  if (authHeader) headers.set('authorization', authHeader);
  // NextRequest 接受 RequestInit + url；body 不用，所以 URL 任意
  return new NextRequest('http://localhost/api/cron/test', { headers });
}

describe('requireCronAuth', () => {
  let envBackup: NodeJS.ProcessEnv;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    envBackup = { ...process.env };
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = envBackup;
    warnSpy.mockRestore();
  });

  it('production + CRON_SECRET missing → 503 fail-closed', async () => {
    (process.env as Record<string, string>).NODE_ENV = 'production';
    delete process.env.CRON_SECRET;
    const res = requireCronAuth(makeRequest('Bearer anything'));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(503);
    const body = await res!.json();
    expect(body.error).toBe('cron_secret_not_configured');
  });

  it('production + CRON_SECRET missing + no auth header → still 503', async () => {
    (process.env as Record<string, string>).NODE_ENV = 'production';
    delete process.env.CRON_SECRET;
    const res = requireCronAuth(makeRequest());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(503);
  });

  it('development + CRON_SECRET missing → allow with warn', () => {
    (process.env as Record<string, string>).NODE_ENV = 'development';
    delete process.env.CRON_SECRET;
    const res = requireCronAuth(makeRequest());
    expect(res).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('test + CRON_SECRET missing → allow with warn', () => {
    // vitest 跑测试时 NODE_ENV 通常是 'test' —— 必须放行否则单测全挂
    (process.env as Record<string, string>).NODE_ENV = 'test';
    delete process.env.CRON_SECRET;
    const res = requireCronAuth(makeRequest());
    expect(res).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('R23-Major-3: NODE_ENV unset + CRON_SECRET missing → 503 (default fail-closed)', async () => {
    // 防回归：OpenNext / Workers 不设 NODE_ENV 时必须 fail-closed
    delete (process.env as Record<string, string | undefined>).NODE_ENV;
    delete process.env.CRON_SECRET;
    const res = requireCronAuth(makeRequest());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(503);
    const body = await res!.json();
    expect(body.message).toContain('NODE_ENV=unset');
  });

  it('R23-Major-3: NODE_ENV=staging (unknown value) + CRON_SECRET missing → 503', async () => {
    // 防回归：unknown env 也 fail-closed
    (process.env as Record<string, string>).NODE_ENV = 'staging';
    delete process.env.CRON_SECRET;
    const res = requireCronAuth(makeRequest());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(503);
  });

  it('CRON_SECRET set + matching auth → allow', () => {
    (process.env as Record<string, string>).NODE_ENV = 'production';
    process.env.CRON_SECRET = 'my-secret';
    const res = requireCronAuth(makeRequest('Bearer my-secret'));
    expect(res).toBeNull();
  });

  it('CRON_SECRET set + mismatched auth → 401', async () => {
    (process.env as Record<string, string>).NODE_ENV = 'production';
    process.env.CRON_SECRET = 'my-secret';
    const res = requireCronAuth(makeRequest('Bearer wrong'));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it('CRON_SECRET set + no auth header → 401', async () => {
    (process.env as Record<string, string>).NODE_ENV = 'production';
    process.env.CRON_SECRET = 'my-secret';
    const res = requireCronAuth(makeRequest());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  // 定长时间比较用 timingSafeEqual，而它对**不等长**输入会直接抛错。
  // 实现里先各自 SHA-256 把长度对齐到 32 字节，所以任意长度的错误头都应
  // 稳稳返回 401 而非 500。这几条锁住的正是「哈希这一步不能被去掉」。
  it.each([
    ['远短于 secret', 'B'],
    ['正确前缀但被截断', 'Bearer my-secre'],
    ['空字符串', ''],
    ['超长输入', 'x'.repeat(10_000)],
  ])('CRON_SECRET set + 长度不等的 auth（%s）→ 401 而非抛错', (_name, header) => {
    (process.env as Record<string, string>).NODE_ENV = 'production';
    process.env.CRON_SECRET = 'my-secret';
    const res = requireCronAuth(makeRequest(header));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });
});
