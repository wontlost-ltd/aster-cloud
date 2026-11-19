// @vitest-environment node
/**
 * en-US 策略的词汇规范预览（ADR 0058 §8.2；aster-lang-ts#365 在 3.4.0 修复）。
 *
 * ★走生产链路：拉起真实网关 `lsp-server.mjs`（不设 LSP_SERVER_SCRIPT，子进程即 node_modules 里 cloud 依赖的那份
 *   aster-lang-ts 语言服务器），以 `?locale=en-US` 经 WebSocket 连接，按编辑器的方式握手：initializationOptions 用
 *   buildLspInitOptions、设置用 buildLspSettings、文档 uri 用 `inmemory://policy/<domain>.aster`，响应经
 *   parseCanonicalPreview 校验。3.3.0 对 en-US 文档不查租户词汇，预览 `mappings` 为空——C5 的浏览器 e2e 因此改在
 *   de-DE 上验收；本用例锁 en-US。
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { buildLspInitOptions, buildLspSettings } from '@/lib/lsp-init-options';
import { parseCanonicalPreview } from '@/lib/structured-authoring/canonical-preview';
import { killGateways, spawnGateway } from '../scripts/fixtures/gateway-process';

const ROOT = join(__dirname, '..', '..', '..');
const ORIGIN = 'http://localhost:3000';
const REQUEST_TIMEOUT_MS = 10_000;
const DOMAIN = 'insurance.auto';
const VOCAB = {
  id: DOMAIN, name: 'Auto insurance', locale: 'en-US', version: '1.0.0',
  structs: [{ canonical: 'Driver', localized: 'Motorist', kind: 'struct' }],
  fields: [{ canonical: 'age', localized: 'years', kind: 'field', parent: 'Driver' }],
  functions: [], enumValues: [], literals: [],
};
const DOC = [
  'Module m.',
  '',
  'Define Motorist has years as Int.',
  '',
  'Rule check given f as Motorist, produce Bool:',
  '  Return f.years greater than 17.',
  '',
].join('\n');

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

const tmp = mkdtempSync(join(tmpdir(), 'lsp-en-us-preview-'));
const gateways: ChildProcess[] = [];
const sockets: WebSocket[] = [];
let port = 0;

afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  await killGateways(gateways);
  rmSync(tmp, { recursive: true, force: true });
});

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

async function preview(vocabularies: readonly unknown[] | undefined) {
  const ws = new WebSocket(`ws://127.0.0.1:${await gateway()}/lsp?locale=en-US`, { headers: { Origin: ORIGIN } });
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  const c = new WsClient(ws);
  await c.request('initialize', {
    processId: null, rootUri: null, capabilities: {},
    initializationOptions: buildLspInitOptions('en-US', 'tenant-en-us', vocabularies),
  });
  c.notify('initialized', {});
  c.notify('workspace/didChangeConfiguration', { settings: { asterLanguageServer: buildLspSettings('en-US') } });
  const uri = `inmemory://policy/${DOMAIN}.aster`;
  c.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'aster-cnl', version: 1, text: DOC } });
  return parseCanonicalPreview(await c.request('aster/canonicalPreview', { textDocument: { uri } }));
}

describe('en-US 策略的词汇规范预览（真实网关 + 语言服务器）', () => {
  it('★带领域词汇：Motorist → Driver、years → age，每个 mapping 的 preview 区间即规范名', async () => {
    const p = await preview([VOCAB]);
    expect(p).not.toBeNull();
    expect(p!.text).toBe(DOC.replace(/Motorist/g, 'Driver').replace(/years/g, 'age'));
    expect(p!.mappings.map((m) => m.canonical)).toEqual(['Driver', 'age', 'Driver', 'age']);
    const at = DOC.indexOf('Motorist');
    expect(p!.mappings[0]!.source).toEqual([at, at + 'Motorist'.length]);
    for (const m of p!.mappings) expect(p!.text.slice(...m.preview)).toBe(m.canonical);
  }, 30_000);

  it('无词汇：预览原样、mappings 为空', async () => {
    const p = await preview(undefined);
    expect(p).not.toBeNull();
    expect(p!.text).toBe(DOC);
    expect(p!.mappings).toEqual([]);
  }, 30_000);
});
