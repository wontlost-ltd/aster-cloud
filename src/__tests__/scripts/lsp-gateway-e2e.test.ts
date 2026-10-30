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
import { connect as netConnect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { REJECTED_CLOSE_TIMEOUT_MS, SESSION_LIMIT_RETRY_AFTER_SECONDS } from '../../../lsp-server.mjs';

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

type Frame = { method?: string; params?: { message?: string; cwd?: string; home?: string; execArgv?: string[] } };

function connect(clientIp?: string): Promise<{ ws: WebSocket; frames: Frame[]; raw: string[]; env: Promise<Frame> }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Origin: ORIGIN };
    if (clientIp) headers['CF-Connecting-IP'] = clientIp;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/lsp?locale=zh-CN&token=${TOKEN}`, { headers });
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

describe('LSP 网关：按客户端限流与子进程堆上限', () => {
  it('★子进程以 --max-old-space-size=128 启动', async () => {
    const c = await connect('198.51.100.1');
    const env = await c.env;
    expect(env.params!.execArgv).toContain('--max-old-space-size=128');
    c.ws.close();
  }, 15_000);

  // 浏览器拿不到握手阶段的 HTTP 状态，故被拒的会话完成握手后立即以 4429 关闭（不 spawn 子进程）
  it('★同一 CF-Connecting-IP 第 4 个会话被拒（关闭码 4429），其他 IP 不受影响', async () => {
    const ip = '198.51.100.7';
    const open = await Promise.all([connect(ip), connect(ip), connect(ip)]);
    const closed = await new Promise<{ code: number; reason: string; messages: number }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/lsp?locale=zh-CN&token=${TOKEN}`, { headers: { Origin: ORIGIN, 'CF-Connecting-IP': ip } });
      let messages = 0;
      ws.on('message', () => { messages++; });
      ws.on('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
      ws.on('close', (code, reason) => resolve({ code, reason: String(reason), messages }));
    });
    expect(closed).toEqual({ code: 4429, reason: `Too many sessions from this client; retry-after=${SESSION_LIMIT_RETRY_AFTER_SECONDS}`, messages: 0 });
    const other = await connect('198.51.100.8');
    other.ws.close();
    // 关闭一个后同一 IP 可再连
    open[0].ws.close();
    await new Promise((r) => setTimeout(r, 300));
    const again = await connect(ip);
    again.ws.close();
    open.slice(1).forEach((c) => c.ws.close());
  }, 20_000);
});

// #665 审查 M1：被拒的握手以 4429 关闭后，对端若不回关闭帧，ws 默认要等 30 秒才销毁 socket；
// 恶意客户端可借此让每次被拒的握手多占一个 fd。被拒连接须在 REJECTED_CLOSE_TIMEOUT_MS 后强制断开。
describe('LSP 网关：被拒连接不滞留', () => {
  /** 手写升级请求、收到 101 与关闭帧后既不回关闭帧也不关 socket；返回服务端断开所用毫秒数 */
  const silentRejectedClient = (ip: string) => new Promise<{ ms: number; data: string }>((resolve, reject) => {
    const sock = netConnect(port, '127.0.0.1');
    let data = '';
    let closeFrameAt = 0;
    sock.on('data', (chunk: Buffer) => {
      data += chunk.toString('latin1');
      // 关闭帧首字节 0x88
      if (!closeFrameAt && chunk.indexOf(0x88) !== -1) closeFrameAt = Date.now();
    });
    sock.on('close', () => (closeFrameAt ? resolve({ ms: Date.now() - closeFrameAt, data }) : reject(new Error(`no close frame: ${data}`))));
    sock.on('error', () => {});
    sock.write([
      `GET /lsp?locale=zh-CN&token=${TOKEN} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13', `Origin: ${ORIGIN}`,
      `CF-Connecting-IP: ${ip}`, '', '',
    ].join('\r\n'));
  });

  it('★不回关闭帧的被拒客户端在约 1 秒内被断开（而非 30 秒）', async () => {
    const ip = '198.51.100.9';
    const open = await Promise.all([connect(ip), connect(ip), connect(ip)]);
    const { ms, data } = await silentRejectedClient(ip);
    expect(data).toContain('101');
    expect(REJECTED_CLOSE_TIMEOUT_MS).toBeLessThanOrEqual(1_000);
    expect(ms).toBeGreaterThanOrEqual(REJECTED_CLOSE_TIMEOUT_MS - 100);
    expect(ms).toBeLessThan(REJECTED_CLOSE_TIMEOUT_MS + 1_000);
    open.forEach((c) => c.ws.close());
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

  const startGateway = async (tmp: string, nodeEnv: 'test' | 'production' = 'test', extraEnv: Record<string, string> = {}) => {
    const p = await freePort();
    const gw = spawnGateway([join(ROOT, 'lsp-server.mjs')], {
      env: { PATH: process.env.PATH, PORT: String(p), HOSTNAME: '127.0.0.1', NODE_ENV: nodeEnv, LSP_AUTH_TOKEN: TOKEN,
        ALLOWED_ORIGINS: ORIGIN, TMPDIR: tmp, LSP_SERVER_SCRIPT: join(__dirname, 'fixtures', 'fake-lsp-server.mjs'), ...extraEnv },
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

  /* 复审 M1：生产缺 CF-Connecting-IP 是配置异常——告警（节流），归入单独的共享桶，不受单 IP 3 会话限制 */
  it('★生产缺 CF-Connecting-IP：共享桶不受单 IP 3 会话限制，告警只记一次', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lsp-gw-nocf-'));
    const { gw, port: p } = await startGateway(tmp, 'production');
    let stderr = '';
    gw.stderr!.on('data', (d) => { stderr += String(d); });
    const open = (): Promise<WebSocket> => new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${p}/lsp?locale=zh-CN&token=${TOKEN}`, { headers: { Origin: ORIGIN } });
      ws.on('open', () => resolve(ws));
      ws.on('unexpected-response', (_q, res) => reject(new Error(`status ${res.statusCode}`)));
      ws.on('error', reject);
    });
    const sockets = [await open(), await open(), await open(), await open()];
    await new Promise((r) => setTimeout(r, 200));
    expect(stderr.match(/without CF-Connecting-IP/g)).toHaveLength(1);
    sockets.forEach((ws) => ws.close());
    gw.kill('SIGTERM');
    rmSync(tmp, { recursive: true, force: true });
  }, 20_000);

  // #657：闲置会话被关闭（4408），子进程退出、工作目录删除；持续有消息的会话不受影响
  it('★闲置超时：无 LSP 消息的会话以 4408 关闭并删除工作目录，活跃会话保持', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lsp-gw-idle-'));
    const { gw, port: p } = await startGateway(tmp, 'test', { LSP_IDLE_TIMEOUT_MS: '1000' });
    const open = async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${p}/lsp?locale=zh-CN&token=${TOKEN}`, { headers: { Origin: ORIGIN } });
      const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
      const env = await new Promise<Frame>((resolve, reject) => {
        ws.on('message', (d) => { const f = JSON.parse(String(d)) as Frame; if (f.method === 'test/env') resolve(f); });
        ws.on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })));
        ws.on('error', reject);
      });
      return { ws, closed, dir: env.params!.cwd! };
    };
    const idle = await open();
    const active = await open();
    const chatter = setInterval(() => active.ws.send(JSON.stringify({ jsonrpc: '2.0', method: '$/ping', params: {} })), 200);
    try {
      expect(await idle.closed).toBe(4408);
      for (let i = 0; i < 50 && existsSync(idle.dir); i++) await new Promise((r) => setTimeout(r, 100));
      expect(existsSync(idle.dir)).toBe(false);
      expect(active.ws.readyState).toBe(WebSocket.OPEN);
      expect(existsSync(active.dir)).toBe(true);
    } finally {
      clearInterval(chatter);
      active.ws.close();
      gw.kill('SIGTERM');
      rmSync(tmp, { recursive: true, force: true });
    }
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

