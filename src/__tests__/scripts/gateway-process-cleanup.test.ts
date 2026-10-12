// @vitest-environment node
/**
 * ★测试进程被强杀（SIGKILL，任何 exit 回调都不执行）时，网关与假语言服务器也必须退出，
 *   且网关自己的 shutdown 会删掉每连接工作目录。曾出现父进程为 PID 1 的孤儿网关。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'lsp-gw-orphan-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const freePort = () => new Promise<number>((resolve) => {
  const srv = createServer().listen(0, () => { const { port } = srv.address() as { port: number }; srv.close(() => resolve(port)); });
});
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('网关进程随测试进程退出', () => {
  it('★父进程被 SIGKILL 后，空闲网关也退出（不成为孤儿）', async () => {
    const port = await freePort();
    const parent = spawn('node', [join(__dirname, 'fixtures', 'spawn-gateway-parent.mjs'), ROOT, String(port), tmp], { stdio: ['ignore', 'pipe', 'inherit'] });
    const info = await new Promise<{ gateway: number; dir: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('gateway not ready')), 10_000);
      parent.stdout!.on('data', (d) => { const line = String(d).trim(); if (line.startsWith('{')) { clearTimeout(timer); resolve(JSON.parse(line)); } });
    });
    expect(alive(info.gateway)).toBe(true);
    // 连接已关闭：网关空闲，工作目录已随连接清理
    expect(existsSync(info.dir)).toBe(false);

    parent.kill('SIGKILL');
    for (let i = 0; i < 50 && alive(info.gateway); i++) await new Promise((r) => setTimeout(r, 100));
    const leaked = alive(info.gateway);
    if (leaked) process.kill(info.gateway, 'SIGKILL'); // 测试失败也别留孤儿
    expect(leaked).toBe(false);
  }, 20_000);
});
