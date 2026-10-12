// 「会被强杀的父进程」：起一个网关（带 die-with-parent 预加载）并建立一条连接，
// 随后关闭连接、等网关空闲，再把网关信息打印给测试，挂起等待被 SIGKILL。
// ★必须是空闲网关：有连接时父进程一死，网关写日志会 EPIPE 崩溃，掩盖真正的孤儿问题。
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const [root, port, tmp] = process.argv.slice(2);
const here = new URL('.', import.meta.url).pathname;
const gw = spawn('node', ['--import', pathToFileURL(join(here, 'die-with-parent.mjs')).href, join(root, 'lsp-server.mjs')], {
  env: { PATH: process.env.PATH, PORT: port, HOSTNAME: '127.0.0.1', NODE_ENV: 'test', LSP_AUTH_TOKEN: 't',
    ALLOWED_ORIGINS: 'http://localhost:3000', TMPDIR: tmp, LSP_SERVER_SCRIPT: join(here, 'fake-lsp-server.mjs') },
  stdio: ['ignore', 'pipe', 'inherit'],
});
gw.stdout.on('data', (d) => {
  if (!String(d).includes('ready on')) return;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/lsp?locale=zh-CN&token=t`, { headers: { Origin: 'http://localhost:3000' } });
  ws.on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })));
  ws.on('message', (m) => {
    const f = JSON.parse(String(m));
    if (f.method !== 'test/env') return;
    ws.close();
    setTimeout(() => process.stdout.write(JSON.stringify({ gateway: gw.pid, dir: f.params.cwd }) + '\n'), 500);
  });
});
setInterval(() => {}, 1000);
