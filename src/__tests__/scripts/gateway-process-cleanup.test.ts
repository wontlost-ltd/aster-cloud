// @vitest-environment node
/**
 * 网关进程清理（测试基础设施自检）。
 *
 * ★测试进程被强杀（SIGKILL，任何 exit 回调都不执行）时，网关必须经由自己的正常 shutdown
 *   退出（die-with-parent 预加载发 SIGTERM）；曾出现父进程为 PID 1 的孤儿网关。
 * ★killGateways 必须杀掉整个进程组：子进程即使不理会 stdin 关闭与 SIGTERM 也要被杀掉。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { killGateways, spawnGateway } from './fixtures/gateway-process';

const ROOT = join(__dirname, '..', '..', '..');
const freePort = () => new Promise<number>((resolve) => {
  const srv = createServer().listen(0, () => { const { port } = srv.address() as { port: number }; srv.close(() => resolve(port)); });
});
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitDead = async (pids: number[], ms: number) => {
  for (let t = 0; t < ms && pids.some(alive); t += 50) await new Promise((r) => setTimeout(r, 50));
};

// ★无论用例成败，都把本用例起的进程（父进程、网关、语言服务器）杀掉、临时目录删掉
const spawned: ChildProcess[] = [];
const pidsToKill: number[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of spawned.splice(0)) { try { c.kill('SIGKILL'); } catch { /* 已退出 */ } }
  await killGateways([]);
  for (const pid of pidsToKill.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('网关进程随测试进程退出', () => {
  it('★父进程被 SIGKILL 后，空闲网关经正常 shutdown 退出（而非 3 秒兜底强退）', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lsp-gw-orphan-'));
    dirs.push(tmp);
    const log = join(tmp, 'gateway.log');
    const port = await freePort();
    const parent = spawn('node', [join(__dirname, 'fixtures', 'spawn-gateway-parent.mjs'), ROOT, String(port), tmp, log], { stdio: ['ignore', 'pipe', 'inherit'] });
    spawned.push(parent);
    const info = await new Promise<{ gateway: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('gateway not ready')), 10_000);
      parent.stdout!.on('data', (d) => { const line = String(d).trim(); if (line.startsWith('{')) { clearTimeout(timer); resolve(JSON.parse(line)); } });
    });
    pidsToKill.push(info.gateway);
    expect(alive(info.gateway)).toBe(true);

    parent.kill('SIGKILL');
    // 兜底强退在 3 秒后才发生：2 秒内退出且日志里有 shutdown，才说明走的是正常关闭路径
    await waitDead([info.gateway], 2_000);
    expect(alive(info.gateway)).toBe(false);
    expect(readFileSync(log, 'utf-8')).toContain('[Server] Shutting down');
  }, 20_000);
});

describe('killGateways 杀整个进程组', () => {
  it('★不理会 stdin 关闭与 SIGTERM 的语言服务器子进程也被杀掉', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lsp-gw-tree-'));
    dirs.push(tmp);
    const port = await freePort();
    const gw = spawnGateway([join(ROOT, 'lsp-server.mjs')], {
      env: { PATH: process.env.PATH, PORT: String(port), HOSTNAME: '127.0.0.1', NODE_ENV: 'test', LSP_AUTH_TOKEN: 't',
        ALLOWED_ORIGINS: 'http://localhost:3000', TMPDIR: tmp, ASTER_FAKE_STUBBORN: '1',
        LSP_SERVER_SCRIPT: join(__dirname, 'fixtures', 'fake-lsp-server.mjs') },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    spawned.push(gw);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('gateway not ready')), 10_000);
      gw.stdout!.on('data', (d) => { if (String(d).includes('ready on')) { clearTimeout(timer); resolve(); } });
    });
    const childPid = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/lsp?locale=zh-CN&token=t`, { headers: { Origin: 'http://localhost:3000' } });
      ws.on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })));
      ws.on('message', (m) => { const f = JSON.parse(String(m)); if (f.method === 'test/env') resolve(f.params.pid); });
      ws.on('error', reject);
    });
    pidsToKill.push(gw.pid!, childPid);
    expect(alive(childPid)).toBe(true);

    await killGateways([gw]);
    await waitDead([gw.pid!, childPid], 2_000);
    expect(alive(gw.pid!)).toBe(false);
    expect(alive(childPid)).toBe(false);
  }, 20_000);
});
