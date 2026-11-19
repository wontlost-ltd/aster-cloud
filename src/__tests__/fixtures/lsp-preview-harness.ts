/**
 * 真实 LSP 网关 + 语言服务器的规范预览测试夹具（ADR 0058 §8.2）。
 *
 * 走生产链路：拉起 `lsp-server.mjs`（不设 LSP_SERVER_SCRIPT，子进程即 node_modules 里 cloud 依赖的那份
 * aster-lang-ts 语言服务器），经 WebSocket 按编辑器的方式握手：initializationOptions 用 buildLspInitOptions、
 * 设置用 buildLspSettings、文档 uri 用 `inmemory://policy/<domain>.aster`，响应经 parseCanonicalPreview 校验。
 * 每个测试文件各自一个网关；文件结束时调用 {@link closeLspPreviewHarness}。
 */
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { buildLspInitOptions, buildLspSettings } from '@/lib/lsp-init-options';
import { parseCanonicalPreview, type CanonicalPreview } from '@/lib/structured-authoring/canonical-preview';
import { killGateways, spawnGateway } from '../scripts/fixtures/gateway-process';

const ROOT = join(__dirname, '..', '..', '..');
const ORIGIN = 'http://localhost:3000';
const REQUEST_TIMEOUT_MS = 10_000;

const freePort = () => new Promise<number>((resolve) => {
  const srv = createServer().listen(0, () => { const { port } = srv.address() as { port: number }; srv.close(() => resolve(port)); });
});

/** 编辑器侧的最小 JSON-RPC 客户端：按 id 取响应（error 或超时即 reject），服务端发来的请求一律回 null。 */
class WsClient {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  constructor(private ws: WebSocket) {
    ws.on('message', (data) => this.onMessage(JSON.parse(String(data))));
    ws.on('close', () => this.failAll(new Error('WebSocket closed')));
    ws.on('error', (e) => this.failAll(e));
  }
  private onMessage(msg: { id?: number | string; method?: string; result?: unknown; error?: { message: string } }) {
    if (msg.method && msg.id !== undefined) return this.send({ id: msg.id, result: null });
    const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    this.pending.delete(msg.id as number);
    if (msg.error) p.reject(new Error(`LSP error: ${msg.error.message}`));
    else p.resolve(msg.result);
  }
  private failAll(e: Error) {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }
  private send(msg: object) {
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', ...msg }));
  }
  request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.send({ id, method, params });
    });
  }
  notify(method: string, params: unknown) {
    this.send({ method, params });
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'lsp-preview-'));
const gateways: ChildProcess[] = [];
const sockets: WebSocket[] = [];
let port = 0;

async function gateway(): Promise<number> {
  if (port) return port;
  const p = await freePort();
  const gw = spawnGateway([join(ROOT, 'lsp-server.mjs')], {
    env: { PATH: process.env.PATH, PORT: String(p), HOSTNAME: '127.0.0.1', NODE_ENV: 'test', ALLOWED_ORIGINS: ORIGIN, TMPDIR: tmp },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  gateways.push(gw);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gateway not ready')), REQUEST_TIMEOUT_MS);
    gw.once('exit', (code) => { clearTimeout(timer); reject(new Error(`gateway exited ${code}`)); });
    gw.stdout!.on('data', (d) => { if (String(d).includes('ready on')) { clearTimeout(timer); resolve(); } });
  });
  port = p;
  return p;
}

/** 以编辑器的握手打开一个文档并请求它的规范预览。 */
export async function requestLspPreview(opts: {
  locale: string;
  tenantId: string;
  domain: string;
  doc: string;
  vocabularies: readonly unknown[] | undefined;
}): Promise<CanonicalPreview | null> {
  const ws = new WebSocket(`ws://127.0.0.1:${await gateway()}/lsp?locale=${opts.locale}`, { headers: { Origin: ORIGIN } });
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  const c = new WsClient(ws);
  await c.request('initialize', {
    processId: null, rootUri: null, capabilities: {},
    initializationOptions: buildLspInitOptions(opts.locale, opts.tenantId, opts.vocabularies),
  });
  c.notify('initialized', {});
  c.notify('workspace/didChangeConfiguration', { settings: { asterLanguageServer: buildLspSettings(opts.locale) } });
  const uri = `inmemory://policy/${opts.domain}.aster`;
  c.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'aster-cnl', version: 1, text: opts.doc } });
  return parseCanonicalPreview(await c.request('aster/canonicalPreview', { textDocument: { uri } }));
}

export async function closeLspPreviewHarness(): Promise<void> {
  for (const ws of sockets) ws.terminate();
  await killGateways(gateways);
  rmSync(tmp, { recursive: true, force: true });
}
