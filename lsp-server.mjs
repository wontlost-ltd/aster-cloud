/**
 * Standalone Aster LSP WebSocket Server
 *
 * This is a lightweight WebSocket server that proxies connections
 * to the Aster CNL Language Server. Designed to run as a separate
 * microservice in Kubernetes while the main app runs on Vercel.
 *
 * Architecture:
 * Browser (Monaco) <--WebSocket--> This Server <--stdio--> Aster LSP Process
 */

import { createServer } from 'http';
import { parse } from 'url';
import { timingSafeEqual } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

const hostname = process.env.HOSTNAME || '0.0.0.0';
const port = parseInt(process.env.PORT || '3001', 10);

const isProduction = process.env.NODE_ENV === 'production';

// CORS configuration
// ★默认值不含 localhost（k3s#489 同源问题）。
//   Origin 是本网关的**主鉴权控制**（fail-closed，见 evaluateUpgrade），
//   把 http://localhost:3000 放进**默认**清单意味着：一旦部署时忘记设
//   ALLOWED_ORIGINS，访客机器上任一监听 3000 端口的本地页面都会成为
//   被允许的 origin —— 而那正是主控制本身被削弱。
//   本地开发请显式设 ALLOWED_ORIGINS（.env.example 已给出示例），
//   让"放宽"成为一次有意识的动作，而不是默认继承。
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://aster-lang.cloud,https://www.aster-lang.cloud')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

// Max concurrent LSP sessions. Each connection spawns a Node child process, so
// an unbounded count is a trivial resource-exhaustion (DoS) vector. Configurable
// via LSP_MAX_CONNECTIONS; defaults to a conservative cap.
const maxConnections = parseInt(process.env.LSP_MAX_CONNECTIONS || '50', 10);

// 按客户端限流的参数（见 createClientLimiter）：单 IP 并发会话 3、握手平均 6 次/分钟、突发 10。
const positiveInt = (raw, fallback) => {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const perClientRate = positiveInt(process.env.LSP_HANDSHAKES_PER_MINUTE, 6);
const perClientBurst = positiveInt(process.env.LSP_HANDSHAKE_BURST, 10);
const clientLimiter = createClientLimiter({
  maxSessionsPerClient: positiveInt(process.env.LSP_MAX_SESSIONS_PER_CLIENT, 3),
  ratePerMinute: perClientRate,
  burst: perClientBurst,
});
// 生产缺 CF-Connecting-IP 的握手共用一个桶（见 clientIdentity）：会话数只受全局上限约束，
// 握手速率放大 10 倍——仍防刷子进程，又不至于让配置异常时所有用户立即被 429。
const missingIpLimiter = createClientLimiter({
  maxSessionsPerClient: maxConnections,
  ratePerMinute: perClientRate * 10,
  burst: perClientBurst * 10,
});
const warnMissingClientIp = createThrottledWarner({
  intervalMs: 5 * 60_000,
  message: 'upgrade without CF-Connecting-IP in production — check the Cloudflare tunnel ingress; using the shared fallback bucket',
});

// Shared-secret gate. Browsers can't set custom WS headers, so the token is
// accepted via header (x-lsp-token, for server-side/proxy callers) OR the
// `token` query param (for the Monaco browser client). NOTE: when delivered to
// the browser the token is necessarily a NEXT_PUBLIC_* value and therefore NOT
// secret from end users — it is a coarse anti-drive-by control layered on top of
// the (primary) fail-closed Origin allowlist, not a substitute for real auth.
// See docs / .env.example: NEXT_PUBLIC_LSP_TOKEN (client) must equal
// LSP_AUTH_TOKEN (server).
const authToken = (process.env.LSP_AUTH_TOKEN || '').trim();
// Escape hatch for local/dev where no token is provisioned. Never set in prod.
const authDisabled = process.env.LSP_AUTH_DISABLED === 'true';

// Track active LSP connections for cleanup
const activeConnections = new Map();

/** 本进程创建、尚未删除的每连接工作目录（shutdown 时同步清理） */
const liveWorkDirs = new Set();
const WORK_DIR_PREFIX = 'aster-lsp-';
const OWNER_FILE = '.owner-pid';
/** 无 owner 文件的遗留目录（旧版本或写入前崩溃）超过这个时长才视为过期 */
const LEGACY_STALE_MS = 60 * 60 * 1000;

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM：进程存在但无权发信号，仍视为存活
    return error?.code === 'EPERM';
  }
}

/**
 * 启动时清理过期的每连接工作目录。
 *
 * ★为什么需要：容器重启（SIGKILL / OOM）时子进程的 exit 回调来不及执行，目录留在 /tmp；
 *   而 /tmp 是 emptyDir，容器重启后仍在，只会越积越多。
 * ★判据按 owner 进程而非一律删除：本地开发或测试可能有多个网关共用同一个 TMPDIR。
 *   - owner 进程已不存在 → 过期
 *   - owner 就是本进程 → 过期（容器里网关通常是 PID 1，重启后 PID 复用；刚启动时本进程
 *     还没创建过任何目录）
 *   - 没有 owner 文件 → 超过 LEGACY_STALE_MS 才删
 *
 * @returns {string[]} 被删除的目录
 */
export function sweepStaleWorkDirs(root = tmpdir(), now = Date.now()) {
  const removed = [];
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(WORK_DIR_PREFIX)) continue;
    const dir = join(root, entry.name);
    let stale;
    try {
      const pid = Number.parseInt(readFileSync(join(dir, OWNER_FILE), 'utf-8'), 10);
      stale = !Number.isFinite(pid) || pid === process.pid || !isProcessAlive(pid);
    } catch {
      try {
        stale = now - statSync(dir).mtimeMs > LEGACY_STALE_MS;
      } catch {
        stale = false;
      }
    }
    if (!stale) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch (error) {
      console.error('[LSP] Failed to sweep stale work dir:', error);
    }
  }
  return removed;
}

/** 限流拒绝会话时的 WebSocket 关闭码（与前端 src/lib/lsp-reconnect.ts 的 LSP_RATE_LIMITED_CLOSE_CODE 一致）。 */
export const RATE_LIMITED_CLOSE_CODE = 4429;

/**
 * 会话数超限时让客户端等待的秒数：会话不会很快释放，不带等待时间的话，同一网络多开的编辑器会持续握手，
 * 耗光该 IP 的握手令牌，挤掉其他标签页的正常重连。
 */
export const SESSION_LIMIT_RETRY_AFTER_SECONDS = 30;

/**
 * 被拒连接发出关闭帧后等待对端回应的上限（毫秒），到时强制断开。ws 默认等 30 秒，
 * 不回关闭帧的客户端可借此让每次被拒的握手多占一个 socket。
 */
export const REJECTED_CLOSE_TIMEOUT_MS = 1_000;

/**
 * 限流拒绝 → WebSocket 关闭帧。浏览器的 WebSocket API 拿不到握手阶段的 HTTP 状态与 Retry-After
 * （只报连接失败），无法据此退避；故被拒的握手照常完成，随即以 4429 关闭，原因里带 `retry-after=N`
 * （前端 parseRetryAfter 解析）。不 spawn 子进程、不占会话名额，代价与直接回 HTTP 429 相当。
 *
 * @param {{ ok?: boolean, code?: number, reason: string, retryAfterSeconds?: number }} limited createClientLimiter.acquire 的拒绝结果
 */
export function rateLimitedClose(limited) {
  const retry = limited.retryAfterSeconds ? `; retry-after=${limited.retryAfterSeconds}` : '';
  return { code: RATE_LIMITED_CLOSE_CODE, reason: `${limited.reason}${retry}` };
}

/**
 * 按客户端（IP）的会话与握手限流。
 *
 * lsp.aster-lang.dev 的 Cloudflare tunnel 直连本 Service、不经 Traefik，入口中间件不生效，故在进程内做。
 * 前端 bundle 内联共享 token 后，任何脚本都能握手；每个会话 spawn 一个约 80 MiB 的子进程，
 * 全局上限（LSP_MAX_CONNECTIONS）之外还要防止单个来源占满：
 *   - 单 IP 并发会话上限（maxSessionsPerClient）；
 *   - 单 IP 握手速率：令牌桶，容量 burst，按 ratePerMinute 补充。
 * 超限结果为 code 429，附 retryAfterSeconds（速率超限按令牌补充时间，会话数超限取固定值）。如何告知客户端见 rateLimitedClose。
 *
 * @param {{ maxSessionsPerClient: number, ratePerMinute: number, burst: number, now?: () => number }} opts
 */
export function createClientLimiter({ maxSessionsPerClient, ratePerMinute, burst, now = Date.now }) {
  const perMs = ratePerMinute / 60_000;
  /** @type {Map<string, { tokens: number, at: number, active: number }>} */
  const clients = new Map();
  let lastSweep = now();

  const refill = (entry, t) => {
    entry.tokens = Math.min(burst, entry.tokens + (t - entry.at) * perMs);
    entry.at = t;
  };

  // 回收「令牌已满且无会话」的条目，防止 Map 随来源 IP 无限增长；至多每分钟扫一次
  const sweep = (t) => {
    if (t - lastSweep < 60_000) return;
    lastSweep = t;
    for (const [key, entry] of clients) {
      refill(entry, t);
      if (entry.active === 0 && entry.tokens >= burst) clients.delete(key);
    }
  };

  return {
    acquire(key) {
      const t = now();
      sweep(t);
      let entry = clients.get(key);
      if (!entry) {
        entry = { tokens: burst, at: t, active: 0 };
        clients.set(key, entry);
      }
      refill(entry, t);
      if (entry.tokens < 1) {
        return { ok: false, code: 429, reason: 'Rate limit exceeded', retryAfterSeconds: Math.ceil((1 - entry.tokens) / perMs / 1000) };
      }
      entry.tokens -= 1;
      if (entry.active >= maxSessionsPerClient) {
        return { ok: false, code: 429, reason: 'Too many sessions from this client', retryAfterSeconds: SESSION_LIMIT_RETRY_AFTER_SECONDS };
      }
      entry.active += 1;
      return { ok: true };
    },
    release(key) {
      const entry = clients.get(key);
      if (entry && entry.active > 0) entry.active -= 1;
    },
    size() {
      return clients.size;
    },
  };
}

/**
 * 限流键的地址归一：IPv4 与 IPv4-mapped IPv6（::ffff:a.b.c.d）按完整 IPv4 地址；
 * 其他 IPv6 按 /64 前缀——IPv6 客户端通常拥有整个 /64，按完整地址计数可以无限换地址绕过。
 * 无法解析的值原样（小写）返回。
 */
export function normalizeClientIp(raw) {
  let ip = String(raw).trim().toLowerCase().replace(/^\[|\]$/g, '');
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  if (!ip.includes(':')) return ip;
  const halves = ip.split('::');
  if (halves.length > 2) return ip;
  const toGroups = (part) => (part ? part.split(':') : []).flatMap((g) => {
    if (!g.includes('.')) return [g];
    const o = g.split('.').map(Number);
    return [((o[0] << 8) | o[1]).toString(16), ((o[2] << 8) | o[3]).toString(16)];
  });
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return ip;
  const groups = [...head, ...Array(fill).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return ip;
  const n = groups.map((g) => parseInt(g, 16));
  // IPv4-mapped（::ffff:a.b.c.d）：按其中的 IPv4 完整地址
  if (n.slice(0, 5).every((x) => x === 0) && n[5] === 0xffff) {
    return [n[6] >> 8, n[6] & 0xff, n[7] >> 8, n[7] & 0xff].join('.');
  }
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

/** 生产上缺 CF-Connecting-IP 的握手共用的桶（见 clientIdentity）。 */
export const MISSING_CLIENT_IP_KEY = 'no-cf-connecting-ip';

/**
 * 限流用的客户端标识。
 *
 * 生产上 lsp.aster-lang.dev 的 Cloudflare tunnel 直连本 Service（ClusterIP，只有 cloudflared 可达），
 * CF-Connecting-IP 由 cloudflared 注入、单值且可信。**生产缺这个头即配置异常**（Cloudflare 配置变更、
 * 入口改道、集群内调用方）：此时对端地址是 cloudflared pod，按它计数会把所有用户挤进两三个桶，
 * 造成大面积 429 且难以定位。故缺头的握手归入单独的共享桶（missingHeader=true，由调用方告警，
 * 并用额度更大的限流器），不按对端地址合并。非生产（本地开发）缺头时按对端地址计数。
 */
export function clientIdentity(headers, remoteAddress, production) {
  const raw = headers['cf-connecting-ip'];
  const cf = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (cf) return { key: normalizeClientIp(cf), missingHeader: false };
  if (production) return { key: MISSING_CLIENT_IP_KEY, missingHeader: true };
  return { key: remoteAddress ? normalizeClientIp(remoteAddress) : 'unknown', missingHeader: false };
}

/**
 * 带节流的告警：首次立即记录，之后每个 intervalMs 窗口至多记一次，并带上累计次数，避免刷屏。
 */
export function createThrottledWarner({ intervalMs, now = Date.now, log = console.warn, message }) {
  let count = 0;
  let lastAt = -Infinity;
  return () => {
    count += 1;
    const t = now();
    if (t - lastAt < intervalMs) return;
    lastAt = t;
    log(`[LSP] WARNING: ${message} (seen ${count} times since start)`);
  };
}

/** 语言服务器子进程的 node 参数：堆上限 128 MiB（子进程不继承网关的 NODE_OPTIONS）。 */
export function childNodeArgs(scriptPath) {
  return ['--max-old-space-size=128', scriptPath, '--stdio'];
}

/**
 * Constant-time string compare to avoid leaking token length/prefix via timing.
 */
function safeTokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Pure, testable WebSocket-upgrade gate.
 *
 * Decides whether an incoming upgrade request is allowed. Extracted so the
 * security policy can be unit-tested without binding a socket.
 *
 * @param {object} input
 * @param {string|undefined} input.origin          - request Origin header
 * @param {string|undefined} input.headerToken     - x-lsp-token header value
 * @param {string|undefined} input.queryToken      - ?token= query value
 * @param {number} input.activeCount               - current active connections
 * @param {object} config
 * @param {string[]} config.allowedOrigins
 * @param {number} config.maxConnections
 * @param {string} config.authToken                - '' means "no token configured"
 * @param {boolean} config.authDisabled
 * @param {boolean} config.isProduction
 * @returns {{ ok: true } | { ok: false, code: number, reason: string }}
 */
export function evaluateUpgrade(input, config) {
  const { origin, headerToken, queryToken, activeCount } = input;
  const { allowedOrigins, maxConnections, authToken, authDisabled, isProduction } = config;

  // 1) Connection cap (DoS guard) — checked first so we reject cheaply.
  if (activeCount >= maxConnections) {
    return { ok: false, code: 503, reason: 'Too many connections' };
  }

  // 2) Origin — FAIL CLOSED. Missing or unlisted origin is rejected (the old
  //    code allowed a missing Origin, letting non-browser clients bypass CORS).
  if (!origin || !allowedOrigins.includes(origin)) {
    return { ok: false, code: 403, reason: 'Forbidden origin' };
  }

  // 3) Shared-secret token.
  if (authToken) {
    const provided = headerToken || queryToken;
    if (!provided || !safeTokenEquals(provided, authToken)) {
      return { ok: false, code: 401, reason: 'Missing or invalid token' };
    }
  } else if (!authDisabled) {
    // No token configured. Fail closed in production; allow in dev so local
    // setups keep working. Operators MUST set LSP_AUTH_TOKEN before deploy.
    if (isProduction) {
      return { ok: false, code: 401, reason: 'Token gate not configured' };
    }
  }

  return { ok: true };
}

// Create HTTP server for health checks and WebSocket upgrade
/**
 * LSP stdio 分帧解码器：按 Content-Length 切出完整消息。
 *
 * ★Content-Length 是 **UTF-8 字节数**。必须在 Buffer 上按字节切，切完整条再解码。
 *   旧实现把 stdout 拼成 JS 字符串后按字符切：中文 1 字符 = 3 字节，切多了，
 *   消息尾部吞进下一条的头，浏览器收到粘连/截断的 JSON；块边界落在多字节字符
 *   中间时 data.toString() 还会产生替换字符。zh 用户的每条含中文的消息都受影响。
 *
 * @returns {{ push(chunk: Buffer): string[] }} 每次 push 返回本次凑齐的完整消息（已解码）
 */
export function createLspFrameDecoder() {
  let buffer = Buffer.alloc(0);
  const separator = Buffer.from('\r\n\r\n');
  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const messages = [];
      for (;;) {
        const headerEnd = buffer.indexOf(separator);
        if (headerEnd === -1) break;
        const header = buffer.subarray(0, headerEnd).toString('ascii');
        const match = header.match(/Content-Length: *(\d+)/i);
        if (!match) {
          // 无 Content-Length 的头无法定界，丢弃该头继续找下一条
          buffer = buffer.subarray(headerEnd + separator.length);
          continue;
        }
        const start = headerEnd + separator.length;
        const end = start + parseInt(match[1], 10);
        if (buffer.length < end) break;
        messages.push(buffer.subarray(start, end).toString('utf-8'));
        buffer = buffer.subarray(end);
      }
      return messages;
    },
  };
}

const server = createServer((req, res) => {
  const { pathname } = parse(req.url, true);

  // CORS headers
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check endpoint
  if (pathname === '/health' || pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      service: 'aster-lsp',
      activeConnections: activeConnections.size,
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  // Readiness check
  if (pathname === '/ready') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ready',
      service: 'aster-lsp',
    }));
    return;
  }

  // Info endpoint
  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      service: 'Aster CNL Language Server Proxy',
      version: '1.0.0',
      websocket: '/lsp',
      health: '/health',
    }));
    return;
  }

  // 404 for other paths
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// Create WebSocket server for LSP connections
const wss = new WebSocketServer({ noServer: true });

// Cloudflare 隧道约 100 秒无流量即断开 WebSocket：空闲编辑器会反复断线重连，
// 重试耗尽后前端报 "[LSP] Initialization failed: Disconnected"。
// 每 30 秒发协议级 ping 保活，并终止上一轮未回 pong 的死连接（ws 官方推荐做法）。
export const KEEPALIVE_INTERVAL_MS = 30_000;
let keepaliveTimer = null;

export function keepaliveTick(clients) {
  for (const ws of clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}

// Handle WebSocket upgrade requests
server.on('upgrade', (request, socket, head) => {
  const { pathname, query } = parse(request.url, true);

  if (pathname !== '/lsp') {
    socket.destroy();
    return;
  }

  const decision = evaluateUpgrade(
    {
      origin: request.headers.origin,
      headerToken: request.headers['x-lsp-token'],
      queryToken: typeof query.token === 'string' ? query.token : undefined,
      activeCount: activeConnections.size,
    },
    { allowedOrigins, maxConnections, authToken, authDisabled, isProduction },
  );

  if (!decision.ok) {
    // Don't echo the offending origin/token back; just log server-side.
    console.log(`[LSP] Rejected upgrade (${decision.code}): ${decision.reason}`);
    socket.write(`HTTP/1.1 ${decision.code} ${decision.reason}\r\n\r\n`);
    socket.destroy();
    return;
  }

  // 按客户端限流在通过 Origin/token 门之后做：只有可能真正 spawn 子进程的握手才计数
  const { key: client, missingHeader } = clientIdentity(request.headers, request.socket.remoteAddress, isProduction);
  if (missingHeader) warnMissingClientIp();
  const limiter = missingHeader ? missingIpLimiter : clientLimiter;
  const limited = limiter.acquire(client);
  if (!limited.ok) {
    console.log(`[LSP] Rejected upgrade (${limited.code}): ${limited.reason}`);
    const close = rateLimitedClose(limited);
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.close(close.code, close.reason);
      // 对端不回关闭帧时不等 ws 默认的 30 秒：到时强制断开
      const timer = setTimeout(() => ws.terminate(), REJECTED_CLOSE_TIMEOUT_MS);
      ws.once('close', () => clearTimeout(timer));
    });
    return;
  }
  // 底层 socket 关闭（会话结束、握手中途失败）时归还名额，恰好一次
  socket.once('close', () => limiter.release(client));

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

// Handle new WebSocket connections
wss.on('connection', (ws, request) => {
  console.log('[LSP] New WebSocket connection');
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // Parse query parameters for locale
  const { query } = parse(request.url, true);
  const locale = query.locale || 'en-US';

  // Spawn the Aster LSP server process
  const lspProcess = spawnLSPServer(locale);

  if (!lspProcess) {
    console.error('[LSP] Failed to spawn LSP server');
    ws.close(1011, 'Failed to start language server');
    return;
  }

  activeConnections.set(ws, lspProcess);

  // Forward messages from WebSocket to LSP process (stdin)
  ws.on('message', (data) => {
    if (lspProcess.stdin && !lspProcess.stdin.destroyed) {
      const message = data.toString();
      // LSP messages need Content-Length header
      const content = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;
      lspProcess.stdin.write(content);
    }
  });

  // Forward messages from LSP process (stdout) to WebSocket
  // Use a message queue to ensure messages are sent one at a time
  const frameDecoder = createLspFrameDecoder();
  const messageQueue = [];
  let isSending = false;

  const processQueue = () => {
    if (isSending || messageQueue.length === 0) return;
    if (ws.readyState !== WebSocket.OPEN) {
      messageQueue.length = 0;
      return;
    }

    isSending = true;
    const message = messageQueue.shift();

    // Use callback to ensure message is sent before processing next
    ws.send(message, (err) => {
      isSending = false;
      if (err) {
        console.error('[LSP] WebSocket send error:', err);
      }
      // Process next message on next tick to prevent coalescing
      if (messageQueue.length > 0) {
        setImmediate(processQueue);
      }
    });
  };

  lspProcess.stdout?.on('data', (data) => {
    // 按字节分帧（见 createLspFrameDecoder），每条完整消息单独成一个 WebSocket 帧
    for (const message of frameDecoder.push(data)) {
      messageQueue.push(message);
    }

    // Start processing queue
    processQueue();
  });

  // Handle LSP process errors
  lspProcess.stderr?.on('data', (data) => {
    console.error('[LSP stderr]', data.toString());
  });

  lspProcess.on('error', (error) => {
    console.error('[LSP] Process error:', error);
    ws.close(1011, 'Language server error');
  });

  lspProcess.on('exit', (code, signal) => {
    console.log(`[LSP] Process exited with code ${code}, signal ${signal}`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1000, 'Language server stopped');
    }
    activeConnections.delete(ws);
  });

  // Handle WebSocket close
  ws.on('close', () => {
    console.log('[LSP] WebSocket closed');
    cleanupLSPProcess(ws);
  });

  // Handle WebSocket errors
  ws.on('error', (error) => {
    console.error('[LSP] WebSocket error:', error);
    cleanupLSPProcess(ws);
  });

  console.log(`[LSP] Connection established with locale: ${locale}`);
});

// Cleanup on server shutdown
const shutdown = () => {
  console.log('[Server] Shutting down...');
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  for (const [ws, lspProcess] of activeConnections) {
    ws.close();
    lspProcess.kill();
  }
  // ★同步删除：下面的 process.exit 不会等子进程的 exit 回调（cleanupWorkDir）执行
  for (const dir of [...liveWorkDirs]) cleanupWorkDir(dir);
  server.close(() => {
    console.log('[Server] Closed');
    process.exit(0);
  });
};

// Only bind the listener / signal handlers when run as the entrypoint
// (`node lsp-server.mjs`). When imported by unit tests we just want the pure
// `evaluateUpgrade` export without a live socket.
const isMain = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isMain) {
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  keepaliveTimer = setInterval(() => keepaliveTick(wss.clients), KEEPALIVE_INTERVAL_MS);

  const swept = sweepStaleWorkDirs();
  if (swept.length > 0) console.log(`[LSP] Swept ${swept.length} stale work dir(s)`);

  // Start server
  server.listen(port, hostname, () => {
    console.log(`> Aster LSP Server ready on http://${hostname}:${port}`);
    console.log(`> WebSocket endpoint: ws://${hostname}:${port}/lsp`);
    console.log(`> Health check: http://${hostname}:${port}/health`);
    if (!authToken && !authDisabled) {
      console.warn(
        '[LSP] WARNING: LSP_AUTH_TOKEN is not set. ' +
          (isProduction
            ? 'Upgrades will be REJECTED (fail-closed) in production.'
            : 'Token gate disabled in non-production; set LSP_AUTH_TOKEN before deploy.'),
      );
    }
  });
}

/**
 * Spawn the Aster LSP server process
 */
function spawnLSPServer(locale) {
  try {
    // Use fileURLToPath to get the directory of this module
    const __dirname = fileURLToPath(new URL('.', import.meta.url));

    // Construct the path to the LSP server directly
    // In production (Docker), node_modules is in the same directory as this file
    // LSP_SERVER_SCRIPT 仅供测试替换为假语言服务器；生产不设置。
    // ★名字刻意不以 ASTER_ 开头：ASTER_* 会被转发给子进程。
    const lspServerPath = process.env.LSP_SERVER_SCRIPT
      || join(__dirname, 'node_modules', '@aster-cloud', 'aster-lang-ts', 'dist', 'src', 'lsp', 'server.js');

    // ★每个连接独立的工作目录（也作 HOME）：语言服务器把工作区索引写在 cwd 下的
    //   .asteri/lsp-index.json，并在启动时读回。所有连接共用 /app 时，一个租户的模块
    //   会出现在另一个租户的 getAllModules() 里（Use <module> 的跳转可解析到别家模块）。
    //   连接结束、子进程退出后整个目录删除（见 cleanupWorkDir）。
    const workDir = mkdtempSync(join(tmpdir(), WORK_DIR_PREFIX));
    // owner 文件供启动时的过期清理判断（见 sweepStaleWorkDirs）
    writeFileSync(join(workDir, OWNER_FILE), String(process.pid));
    liveWorkDirs.add(workDir);

    console.log(`[LSP] Starting LSP server from: ${lspServerPath}`);

    // Pass a minimal, explicit env to the child instead of spreading the whole
    // process environment. The proxy holds secrets (LSP_AUTH_TOKEN, any infra
    // creds injected by the orchestrator); the compiler/language-server has no
    // business inheriting them. Only forward what it actually needs to run.
    const childEnv = {
      PATH: process.env.PATH,
      HOME: workDir,
      NODE_ENV: process.env.NODE_ENV,
      ASTER_LOCALE: locale,
    };
    // Forward any explicitly opted-in ASTER_* tuning vars (e.g. ASTER_LOG_LEVEL)
    // without leaking unrelated secrets.
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith('ASTER_') && k !== 'ASTER_LOCALE' && v !== undefined) {
        childEnv[k] = v;
      }
    }

    const lspProcess = spawn('node', childNodeArgs(lspServerPath), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
      cwd: workDir,
    });
    // 子进程无论因何退出（连接关闭 SIGTERM、崩溃）都删掉它的工作目录
    lspProcess.once('exit', () => cleanupWorkDir(workDir));
    lspProcess.once('error', () => cleanupWorkDir(workDir));

    return lspProcess;
  } catch (error) {
    console.error('[LSP] Failed to spawn LSP server:', error);
    return null;
  }
}

/** 删除连接专属工作目录；失败只记日志，不影响网关 */
function cleanupWorkDir(dir) {
  liveWorkDirs.delete(dir);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    console.error('[LSP] Failed to remove work dir:', error);
  }
}

/**
 * Cleanup LSP process when WebSocket closes
 */
function cleanupLSPProcess(ws) {
  const lspProcess = activeConnections.get(ws);
  if (lspProcess) {
    if (!lspProcess.killed) {
      lspProcess.kill('SIGTERM');
    }
    activeConnections.delete(ws);
  }
}
