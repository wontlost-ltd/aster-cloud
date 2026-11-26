// 迁移脚本入口（ADR 0051 §9）：缺内部地址或签名密钥时拒绝运行、非零退出，绝不回落到生产地址；--help 写明已知限制。
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const IMAGE_DEPS_HOOK = join(__dirname, 'fixtures', 'image-deps-only-hook.mjs');

function runCli(args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, ['--conditions=import', '--import', 'tsx', 'scripts/resolver-migration.ts', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    // 只给最小环境，并让 dotenv 读不到任何 .env，确保配置只来自这里
    env: {
      NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '',
      DOTENV_CONFIG_PATH: '/nonexistent/.env', ...env,
    },
  });
}

describe('scripts/resolver-migration.ts', () => {
  it('缺 ASTER_POLICY_API_INTERNAL_URL 与签名密钥 → 退出码 2 并点名缺失项', () => {
    const result = runCli([], { DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('refusing to run');
    expect(result.stderr).toContain('ASTER_POLICY_API_INTERNAL_URL');
    expect(result.stderr).toContain('ASTER_PLAN_GATE_HMAC_KEY');
    expect(result.stdout).not.toContain('"processed"');
  });

  it('只缺签名密钥同样拒绝', () => {
    const result = runCli([], { DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none', ASTER_POLICY_API_INTERNAL_URL: 'http://127.0.0.1:1' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('missing ASTER_PLAN_GATE_HMAC_KEY');
  });

  it('--help 写明运行方式与已知限制', () => {
    const result = runCli(['--help'], {});
    expect(result.status).toBe(0);
    for (const text of [
      '--conditions=import', 'no fallback', 'Success means', 'integrityMismatch', 'heuristic', 'E057 / E064',
      'pg_dump', 'HASH_MISMATCH', 'without\n    diagnostics', 'COMPILE_INTERNAL_ERROR',
      'ASTER_CLOUD_INTERNAL_URL', '/api/internal/policies/<id>/invalidate-cache',
    ]) {
      expect(result.stdout).toContain(text);
    }
  });

  describe('镜像依赖集合下可启动（#853）', () => {
    // 与 Dockerfile.resolver-migration 的运行时清单同源：引擎包 + deps 阶段 for 循环里的包名。
    function imageDependencies(): string[] {
      const dockerfile = readFileSync(join(ROOT, 'Dockerfile.resolver-migration'), 'utf8');
      const list = /for \(const n of (\[[^\]]*\])\)/.exec(dockerfile)?.[1];
      if (!list) throw new Error('Dockerfile.resolver-migration 里找不到运行时依赖清单');
      return ['@aster-cloud/aster-lang-ts', ...(JSON.parse(list) as string[])];
    }

    function runWithImageDeps(entry: string, args: string[]) {
      return spawnSync(
        process.execPath,
        ['--conditions=import', '--import', IMAGE_DEPS_HOOK, '--import', 'tsx', entry, ...args],
        {
          cwd: ROOT,
          encoding: 'utf8',
          timeout: 60_000,
          env: {
            NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '',
            DOTENV_CONFIG_PATH: '/nonexistent/.env', IMAGE_DEPENDENCIES: JSON.stringify(imageDependencies()),
          },
        },
      );
    }

    it('清单不含 next：镜像确实不装 Next.js 运行时', () => {
      expect(imageDependencies()).toEqual(expect.arrayContaining(['@aster-cloud/aster-lang-ts', 'pg', 'tsx']));
      expect(imageDependencies()).not.toContain('next');
    });

    it('生产命令 --help 能加载完整导入图（不经 next/server 等镜像外的包）', () => {
      const result = runWithImageDeps('scripts/resolver-migration.ts', ['--help']);
      expect(result.stderr).not.toContain('Cannot find package');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('resolver migration');
    });

    it('反例：导入了镜像外的包（next/server）→ 按镜像里的报错失败', () => {
      const result = runWithImageDeps('src/__tests__/scripts/fixtures/imports-next.ts', []);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Cannot find package 'next'");
    });
  });
});
