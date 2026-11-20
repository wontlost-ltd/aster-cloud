/**
 * 测试进程中的 aster-api 客户端绝不能解析到生产域 *.aster-lang.dev（#824）。
 *
 * 三层守卫：
 *   1. 回落规则本身：测试进程未配置 / 配成生产域 → 不可达的本机地址；非测试进程保持生产回落。
 *   2. 行为：未设任何 env 时，Guard 部署客户端真正发出的请求不指向 *.aster-lang.dev。
 *   3. 静态：除回落规则模块与 CSP（响应头里的来源白名单，不是客户端）外，源码里不得再出现
 *      `policy.aster-lang.dev` 字面量——新增客户端只能经 resolvePolicyApiBaseUrl 取基址。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PRODUCTION_POLICY_API_URL,
  PRODUCTION_POLICY_WS_URL,
  TEST_UNCONFIGURED_POLICY_API_URL,
  TEST_UNCONFIGURED_POLICY_WS_URL,
  isProductionAsterHost,
  isTestRuntime,
  resolvePolicyApiBaseUrl,
  resolvePolicyWsUrl,
} from '@/lib/policy-api-url';

const API_URL_ENV = [
  'ASTER_POLICY_API_INTERNAL_URL',
  'NEXT_PUBLIC_ASTER_POLICY_API_URL',
  'NEXT_PUBLIC_ASTER_POLICY_WS_URL',
] as const;

function unsetApiUrlEnv(): void {
  for (const key of API_URL_ENV) vi.stubEnv(key, undefined);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('resolvePolicyApiBaseUrl：测试进程 fail closed', () => {
  it('vitest 进程被识别为测试运行', () => {
    expect(isTestRuntime()).toBe(true);
  });

  it('未配置时回落到不可达的本机地址，而非生产', () => {
    expect(resolvePolicyApiBaseUrl()).toBe(TEST_UNCONFIGURED_POLICY_API_URL);
    expect(resolvePolicyApiBaseUrl(undefined, '', '  ')).toBe(TEST_UNCONFIGURED_POLICY_API_URL);
    expect(resolvePolicyWsUrl()).toBe(TEST_UNCONFIGURED_POLICY_WS_URL);
    expect(isProductionAsterHost(TEST_UNCONFIGURED_POLICY_API_URL)).toBe(false);
  });

  it('显式配置成生产域（含子域、大小写）也拒绝', () => {
    for (const url of [
      'https://policy.aster-lang.dev',
      'https://POLICY.Aster-Lang.DEV/api',
      'https://aster-lang.dev',
      'wss://policy.aster-lang.dev/ws/preview',
    ]) {
      expect(resolvePolicyApiBaseUrl(url), url).toBe(TEST_UNCONFIGURED_POLICY_API_URL);
    }
    expect(resolvePolicyWsUrl('wss://policy.aster-lang.dev/ws/preview')).toBe(TEST_UNCONFIGURED_POLICY_WS_URL);
  });

  it('本地 / mock aster-api 照常使用，按优先级取第一个非空值', () => {
    expect(resolvePolicyApiBaseUrl(undefined, 'http://localhost:8080')).toBe('http://localhost:8080');
    expect(resolvePolicyApiBaseUrl('http://aster-api:8080', 'http://localhost:8080')).toBe('http://aster-api:8080');
    // 形似但不是生产域的主机不受影响
    expect(resolvePolicyApiBaseUrl('http://not-aster-lang.dev.example')).toBe('http://not-aster-lang.dev.example');
  });

  it('非测试进程保持原有回落：未配置 → 生产，已配置 → 原样', () => {
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'production');
    expect(isTestRuntime()).toBe(false);
    expect(resolvePolicyApiBaseUrl()).toBe(PRODUCTION_POLICY_API_URL);
    expect(resolvePolicyWsUrl()).toBe(PRODUCTION_POLICY_WS_URL);
    expect(resolvePolicyApiBaseUrl(undefined, 'https://policy.aster-lang.dev')).toBe('https://policy.aster-lang.dev');
  });

  it('NODE_ENV=test 即便没有 VITEST 也算测试运行', () => {
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'test');
    expect(resolvePolicyApiBaseUrl()).toBe(TEST_UNCONFIGURED_POLICY_API_URL);
  });
});

describe('测试进程里的 aster-api 客户端不解析到 *.aster-lang.dev', () => {
  it('PolicyApiClient 配置（REST + WebSocket）', async () => {
    unsetApiUrlEnv();
    const { getApiConfig } = await import('@/services/policy/policy-api');
    const config = getApiConfig();
    expect(isProductionAsterHost(config.baseUrl)).toBe(false);
    expect(isProductionAsterHost(config.wsUrl)).toBe(false);
  });

  it('Guard 部署（#824 的泄漏路径）发出的请求指向本机不可达地址', async () => {
    unsetApiUrlEnv();
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ policyVersionId: 1 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const { PolicyApiClient } = await import('@/services/policy/policy-api');
    await new PolicyApiClient('tenant-1', 'user-1').deployGuardPolicy('pol-1', {
      generation: 1,
      cloudVersionId: 'v-1',
      cloudVersion: 1,
      moduleName: 'm',
      functionName: 'f',
      source: 'x',
      locale: 'en-US',
      sourceSha256: '0'.repeat(64),
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = String((fetchSpy.mock.calls[0] as unknown[])[0]);
    expect(url.startsWith(`${TEST_UNCONFIGURED_POLICY_API_URL}/`)).toBe(true);
    expect(isProductionAsterHost(url)).toBe(false);
  });
});

describe('源码里不再硬编码生产 aster-api 地址', () => {
  const SRC = path.resolve(__dirname, '../..');
  /** 允许出现该字面量的文件：回落规则本身，以及 CSP（只是响应头里的来源白名单）。 */
  const ALLOWED = new Set(['lib/policy-api-url.ts', 'lib/security/csp.ts']);

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sourceFiles(full);
      return /\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) ? [full] : [];
    });
  }

  it('policy.aster-lang.dev 只出现在允许的文件与注释中', () => {
    const offenders = sourceFiles(SRC)
      .map((file) => path.relative(SRC, file).split(path.sep).join('/'))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) =>
        readFileSync(path.join(SRC, rel), 'utf8')
          .split('\n')
          .some((line) => /['"`](https?|wss?):\/\/policy\.aster-lang\.dev/.test(line)),
      );
    expect(offenders).toEqual([]);
  });
});
