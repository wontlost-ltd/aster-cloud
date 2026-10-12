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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

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
  gateway = spawn('node', [join(ROOT, 'lsp-server.mjs')], {
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
}, 20_000);

afterAll(() => {
  gateway?.kill('SIGTERM');
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

    a.ws.close(); b.ws.close();
    for (let i = 0; i < 50 && (existsSync(dirA) || existsSync(dirB)); i++) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(dirA)).toBe(false);
    expect(existsSync(dirB)).toBe(false);
  }, 15_000);
});
