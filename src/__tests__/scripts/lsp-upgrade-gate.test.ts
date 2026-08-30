/**
 * Unit tests for the standalone LSP WebSocket upgrade gate (GitHub #98).
 *
 * Locks the security policy in lsp-server.mjs `evaluateUpgrade`:
 *   - connection cap (DoS guard)
 *   - FAIL-CLOSED origin (missing/unlisted origin rejected)
 *   - shared-secret token requirement (header or query)
 *   - fail-closed when no token configured in production
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Importing the .mjs only pulls in the pure export; the listener bootstrap is
// guarded behind an isMain check so no socket is bound under test.
import { evaluateUpgrade } from '../../../lsp-server.mjs';

const ORIGINS = ['https://aster-lang.cloud', 'http://localhost:3000'];

function cfg(overrides: Partial<Parameters<typeof evaluateUpgrade>[1]> = {}) {
  return {
    allowedOrigins: ORIGINS,
    maxConnections: 2,
    authToken: 'sekret',
    authDisabled: false,
    isProduction: true,
    ...overrides,
  };
}

function input(overrides: Partial<Parameters<typeof evaluateUpgrade>[0]> = {}) {
  return {
    origin: 'https://aster-lang.cloud',
    headerToken: undefined,
    queryToken: 'sekret',
    activeCount: 0,
    ...overrides,
  };
}

describe('evaluateUpgrade — connection cap', () => {
  it('rejects (503) when at or over the cap', () => {
    expect(evaluateUpgrade(input({ activeCount: 2 }), cfg())).toEqual({
      ok: false,
      code: 503,
      reason: 'Too many connections',
    });
  });

  it('allows when under the cap', () => {
    expect(evaluateUpgrade(input({ activeCount: 1 }), cfg())).toEqual({ ok: true });
  });
});

describe('evaluateUpgrade — origin (fail closed)', () => {
  it('rejects (403) when Origin is absent', () => {
    expect(evaluateUpgrade(input({ origin: undefined }), cfg())).toMatchObject({
      ok: false,
      code: 403,
    });
  });

  it('rejects (403) when Origin is not in the allowlist', () => {
    expect(evaluateUpgrade(input({ origin: 'https://evil.example' }), cfg())).toMatchObject({
      ok: false,
      code: 403,
    });
  });

  it('allows a listed origin', () => {
    expect(evaluateUpgrade(input({ origin: 'http://localhost:3000' }), cfg())).toEqual({
      ok: true,
    });
  });
});

describe('evaluateUpgrade — token', () => {
  it('rejects (401) when token missing', () => {
    expect(
      evaluateUpgrade(input({ queryToken: undefined, headerToken: undefined }), cfg()),
    ).toMatchObject({ ok: false, code: 401 });
  });

  it('rejects (401) when token wrong', () => {
    expect(evaluateUpgrade(input({ queryToken: 'nope' }), cfg())).toMatchObject({
      ok: false,
      code: 401,
    });
  });

  it('accepts token via query param', () => {
    expect(evaluateUpgrade(input({ queryToken: 'sekret' }), cfg())).toEqual({ ok: true });
  });

  it('accepts token via x-lsp-token header', () => {
    expect(
      evaluateUpgrade(input({ queryToken: undefined, headerToken: 'sekret' }), cfg()),
    ).toEqual({ ok: true });
  });
});

describe('evaluateUpgrade — token gate not configured', () => {
  it('fails closed (401) in production when no token configured', () => {
    expect(
      evaluateUpgrade(input({ queryToken: undefined }), cfg({ authToken: '' })),
    ).toMatchObject({ ok: false, code: 401, reason: 'Token gate not configured' });
  });

  it('allows in non-production when no token configured (dev convenience)', () => {
    expect(
      evaluateUpgrade(
        input({ queryToken: undefined }),
        cfg({ authToken: '', isProduction: false }),
      ),
    ).toEqual({ ok: true });
  });

  it('allows when no token configured but auth explicitly disabled', () => {
    expect(
      evaluateUpgrade(
        input({ queryToken: undefined }),
        cfg({ authToken: '', authDisabled: true }),
      ),
    ).toEqual({ ok: true });
  });
});

describe('evaluateUpgrade — precedence', () => {
  it('cap is checked before origin', () => {
    expect(
      evaluateUpgrade(input({ activeCount: 5, origin: 'https://evil.example' }), cfg()),
    ).toMatchObject({ code: 503 });
  });

  it('origin is checked before token', () => {
    expect(
      evaluateUpgrade(input({ origin: 'https://evil.example', queryToken: undefined }), cfg()),
    ).toMatchObject({ code: 403 });
  });
});

/**
 * 默认 origin 清单不得包含 localhost（k3s#489 同源问题）。
 *
 * ★Origin 是本网关的**主鉴权控制**（fail-closed）。把 http://localhost:3000
 * 放进**默认**清单意味着：部署时一旦忘记设 ALLOWED_ORIGINS，访客机器上任一
 * 监听 3000 端口的本地页面都会成为被允许的 origin —— 主控制本身被削弱。
 *
 * 本地开发应显式设 ALLOWED_ORIGINS（.env.example 已给出含 localhost 的示例），
 * 让"放宽"是一次有意识的动作，而不是默认继承。
 */
describe('LSP 网关默认 origin 清单', () => {
  it('★源码里的默认值不含 localhost', () => {
    // ★用 process.cwd() 而非 import.meta.url：vitest 下 import.meta.url 不是
    //   file: scheme，readFileSync(URL) 会抛 "The URL must be of scheme file"。
    //   同目录的 check-lsp-pin.test.ts 也是基于仓库根拼路径。
    const src = readFileSync(join(process.cwd(), 'lsp-server.mjs'), 'utf-8');
    // ★只看**非注释**的实现行：注释里提到 localhost 是在解释"为何不放"，
    //   若把注释也算进来，本守卫会因自己的说明文字而恒红（第一版就踩了这个）。
    const line = src
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .find((l) => l.includes('const allowedOrigins'));
    expect(line, '未找到 allowedOrigins 默认值行——实现结构变了，本守卫需同步更新').toBeTruthy();
    expect(line).not.toContain('localhost');
  });
});
