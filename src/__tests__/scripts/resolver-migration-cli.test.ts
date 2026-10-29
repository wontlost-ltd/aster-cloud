// 迁移脚本入口（ADR 0051 §9）：缺内部地址或签名密钥时拒绝运行、非零退出，绝不回落到生产地址；--help 写明已知限制。
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');

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
    for (const text of ['--conditions=import', 'no fallback', 'Success means', 'integrityMismatch', 'heuristic', 'P005']) {
      expect(result.stdout).toContain(text);
    }
  });
});
