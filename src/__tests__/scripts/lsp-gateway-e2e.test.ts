// @vitest-environment node
/**
 * 网关端到端：真实拉起 lsp-server.mjs，子进程换成假语言服务器（LSP_SERVER_SCRIPT）。
 *
 * ★锁两处接线（单测解码器本身锁不住）：
 *   - stdout 处理必须经过按字节分帧的解码器：含中文、被块边界切开的消息要整条到达，
 *     且一帧恰好一条消息。
 *   - 每个连接独立的工作目录 / HOME（语言服务器把工作区索引写在 cwd 下），
 *     两个连接互不相同，连接关闭后目录被删除。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { killAllGateways, killGateways, spawnGateway } from './fixtures/gateway-process';

const ROOT = join(__dirname, '..', '..', '..');
const ORIGIN = 'http://localhost:3000';
const TOKEN = 'gateway-e2e-token';
let gateway: ChildProcess;
let port: number;
let tmpRoot: string;

const freePort = () => new Promise<number>((resolve) => {
  const srv = createServer().listen(0, () => {
    const { port: p } = srv.address() as { port: number };
    srv.close(() => resolve(p));
  });
});

beforeAll(async () => {
  port = await freePort();
  tmpRoot = mkdtempSync(join(tmpdir(), 'lsp-gw-e2e-'));
  gateway = spawnGateway([join(ROOT, 'lsp-server.mjs')], {
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      NODE_ENV: 'test',
      LSP_AUTH_TOKEN: TOKEN,
      ALLOWED_ORIGINS: ORIGIN,
      TMPDIR: tmpRoot,
      LSP_SERVER_SCRIPT: join(__dirname, 'fixtures', 'fake-lsp-server.mjs'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gateway did not start')), 10_000);
    gateway.stdout!.on('data', (d) => { if (String(d).includes('ready on')) { clearTimeout(timer); resolve(); } });
  });
  // 网关必须带 die-with-parent 预加载：测试进程被强杀时它才会随之退出（见 gateway-process.ts）
  expect(gateway.spawnargs.some((x) => x.endsWith('die-with-parent.mjs'))).toBe(true);
}, 20_000);

// ★无论用例成败都杀掉网关进程组（含假语言服务器），避免留下孤儿进程
afterAll(async () => {
  await killAllGateways();
  rmSync(tmpRoot, { recursive: true, force: true });
});

type Frame = { method?: string; params?: { message?: string; cwd?: string; home?: string } };

function connect(): Promise<{ ws: WebSocket; frames: Frame[]; raw: string[]; env: Promise<Frame> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/lsp?locale=zh-CN&token=${TOKEN}`, { headers: { Origin: ORIGIN } });
    const frames: Frame[] = []; const raw: string[] = [];
    let gotEnv: (f: Frame) => void;
    const env = new Promise<Frame>((r) => { gotEnv = r; });
    ws.on('message', (data) => {
      raw.push(String(data));
      const f = JSON.parse(String(data)) as Frame; // 一帧必须恰为一条完整 JSON
      frames.push(f);
      if (f.method === 'test/env') gotEnv(f);
    });
    ws.on('open', () => { ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })); resolve({ ws, frames, raw, env }); });
    ws.on('error', reject);
  });
}

describe('LSP 网关端到端', () => {
  it('★含中文且被切开的消息整条到达，一帧一条', async () => {
    const c = await connect();
    await c.env;
    expect(c.frames[0]).toEqual({ jsonrpc: '2.0', method: 'window/logMessage', params: { type: 3, message: '模块 已加载：规则 计算' } });
    expect(c.raw.every((r) => !r.includes('�'))).toBe(true);
    c.ws.close();
  }, 15_000);

  it('★每个连接独立的工作目录 / HOME，关闭后删除', async () => {
    const a = await connect();
    const b = await connect();
    const [ea, eb] = await Promise.all([a.env, b.env]);
    const dirA = ea.params!.cwd!; const dirB = eb.params!.cwd!;
    expect(dirA).not.toBe(dirB);
    // macOS 上 /var 是 /private/var 的别名，按真实路径比较
    expect(realpathSync(ea.params!.home!)).toBe(realpathSync(dirA));
    expect(realpathSync(dirA).startsWith(realpathSync(tmpRoot))).toBe(true);
    expect(existsSync(dirA)).toBe(true);
    // owner 文件供启动时的过期清理判断（sweepStaleWorkDirs）
    expect(existsSync(join(dirA, '.owner-pid'))).toBe(true);

    a.ws.close(); b.ws.close();
    for (let i = 0; i < 50 && (existsSync(dirA) || existsSync(dirB)); i++) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(dirA)).toBe(false);
    expect(existsSync(dirB)).toBe(false);
  }, 15_000);
});

/* ★独立网关实例：SIGTERM 时 shutdown() 直接 process.exit，子进程的 exit 回调来不及清理目录；
 *   启动时还要清掉上一次被 SIGKILL 留下的目录。 */
describe('网关生命周期：工作目录清理', () => {
  // 本组每个用例自起网关：用例失败时也在这里杀掉，而不是依赖用例末尾的 kill
  const started: ChildProcess[] = [];
  afterEach(async () => {
    await killGateways(started.splice(0));
  });

  const startGateway = async (tmp: string) => {
    const p = await freePort();
    const gw = spawnGateway([join(ROOT, 'lsp-server.mjs')], {
      env: { PATH: process.env.PATH, PORT: String(p), HOSTNAME: '127.0.0.1', NODE_ENV: 'test', LSP_AUTH_TOKEN: TOKEN,
        ALLOWED_ORIGINS: ORIGIN, TMPDIR: tmp, LSP_SERVER_SCRIPT: join(__dirname, 'fixtures', 'fake-lsp-server.mjs') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    started.push(gw);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('gateway did not start')), 10_000);
      gw.stdout!.on('data', (d) => { if (String(d).includes('ready on')) { clearTimeout(timer); resolve(); } });
    });
    return { gw, port: p };
  };

  it('★SIGTERM 关闭网关后不留下每连接工作目录', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lsp-gw-term-'));
    const { gw, port: p } = await startGateway(tmp);
    const ws = new WebSocket(`ws://127.0.0.1:${p}/lsp?locale=zh-CN&token=${TOKEN}`, { headers: { Origin: ORIGIN } });
    const env = await new Promise<Frame>((resolve, reject) => {
      ws.on('message', (d) => { const f = JSON.parse(String(d)) as Frame; if (f.method === 'test/env') resolve(f); });
      ws.on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })));
      ws.on('error', reject);
    });
    const dir = env.params!.cwd!;
    expect(existsSync(dir)).toBe(true);
    const exited = new Promise((r) => gw.once('exit', r));
    gw.kill('SIGTERM');
    await exited;
    expect(existsSync(dir)).toBe(false);
    rmSync(tmp, { recursive: true, force: true });
  }, 20_000);

  it('★启动时清掉 owner 已退出的遗留目录', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lsp-gw-sweep-'));
    const stale = join(tmp, 'aster-lsp-stale');
    mkdirSync(stale);
    const dead = spawnSync('node', ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf-8' }).stdout.trim();
    writeFileSync(join(stale, '.owner-pid'), dead);
    const { gw } = await startGateway(tmp);
    expect(existsSync(stale)).toBe(false);
    gw.kill('SIGTERM');
    rmSync(tmp, { recursive: true, force: true });
  }, 20_000);
});

