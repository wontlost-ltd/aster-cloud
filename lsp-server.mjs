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

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

// Handle new WebSocket connections
wss.on('connection', (ws, request) => {
  console.log('[LSP] New WebSocket connection');

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
  let buffer = '';
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
    buffer += data.toString();

    // Parse LSP messages (Content-Length header format)
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = buffer.slice(0, headerEnd);
      const contentLengthMatch = header.match(/Content-Length: (\d+)/i);
      if (!contentLengthMatch) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(contentLengthMatch[1], 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;

      if (buffer.length < messageEnd) break;

      const message = buffer.slice(messageStart, messageEnd);
      buffer = buffer.slice(messageEnd);

      // Queue message instead of sending directly
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
  for (const [ws, lspProcess] of activeConnections) {
    ws.close();
    lspProcess.kill();
  }
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
    const lspServerPath = join(__dirname, 'node_modules', '@aster-cloud', 'aster-lang-ts', 'dist', 'src', 'lsp', 'server.js');

    console.log(`[LSP] Starting LSP server from: ${lspServerPath}`);

    // Pass a minimal, explicit env to the child instead of spreading the whole
    // process environment. The proxy holds secrets (LSP_AUTH_TOKEN, any infra
    // creds injected by the orchestrator); the compiler/language-server has no
    // business inheriting them. Only forward what it actually needs to run.
    const childEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
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

    const lspProcess = spawn('node', [lspServerPath, '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    });

    return lspProcess;
  } catch (error) {
    console.error('[LSP] Failed to spawn LSP server:', error);
    return null;
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
