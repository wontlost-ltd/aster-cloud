// @vitest-environment node
/**
 * en-US 策略的词汇规范预览（ADR 0058 §8.2；aster-lang-ts#365 在 3.4.0 修复）。
 *
 * ★真实拉起 cloud 依赖的那份语言服务器（node_modules 里的 aster-lang-ts，与 lsp-server.mjs 网关的子进程同一脚本、
 *   同一 `--stdio` 参数），按编辑器的方式握手：initializationOptions 用 buildLspInitOptions、设置用 buildLspSettings、
 *   文档 uri 用 `inmemory://policy/<domain>.aster`，响应经 parseCanonicalPreview 校验。
 *   3.3.0 对 en-US 文档不查租户词汇，预览 `mappings` 为空——C5 的浏览器 e2e 因此改在 de-DE 上验收；本用例锁 en-US。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLspInitOptions, buildLspSettings } from '@/lib/lsp-init-options';
import { parseCanonicalPreview } from '@/lib/structured-authoring/canonical-preview';

const SERVER = join(process.cwd(), 'node_modules', '@aster-cloud', 'aster-lang-ts', 'dist', 'src', 'lsp', 'server.js');
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

/** 最小 LSP stdio 客户端：Content-Length 分帧，按 id 取响应，服务端发来的请求一律回 null。 */
class StdioClient {
  private buf = Buffer.alloc(0);
  private seq = 0;
  private pending = new Map<number, (v: unknown) => void>();
  constructor(private proc: ChildProcessWithoutNullStreams) {
    proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
  }
  private write(msg: object) {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }), 'utf-8');
    this.proc.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }
  private onData(chunk: Buffer) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const end = this.buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const len = Number(/Content-Length: (\d+)/i.exec(this.buf.subarray(0, end).toString())?.[1]);
      if (this.buf.length < end + 4 + len) return;
      const msg = JSON.parse(this.buf.subarray(end + 4, end + 4 + len).toString('utf-8'));
      this.buf = this.buf.subarray(end + 4 + len);
      if (msg.method && msg.id !== undefined) this.write({ id: msg.id, result: null });
      else if (msg.id !== undefined) this.pending.get(msg.id)?.(msg.result);
    }
  }
  request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.write({ id, method, params });
    });
  }
  notify(method: string, params: unknown) {
    this.write({ method, params });
  }
}

const workDir = mkdtempSync(join(tmpdir(), 'lsp-en-us-preview-'));
const procs: ChildProcessWithoutNullStreams[] = [];
afterAll(() => {
  for (const p of procs) p.kill();
  rmSync(workDir, { recursive: true, force: true });
});

async function preview(vocabularies: readonly unknown[] | undefined) {
  const proc = spawn(process.execPath, ['--max-old-space-size=128', SERVER, '--stdio'], { cwd: workDir });
  procs.push(proc);
  const c = new StdioClient(proc);
  await c.request('initialize', {
    processId: process.pid, rootUri: null, capabilities: {},
    initializationOptions: buildLspInitOptions('en-US', 'tenant-en-us', vocabularies),
  });
  c.notify('initialized', {});
  c.notify('workspace/didChangeConfiguration', { settings: { asterLanguageServer: buildLspSettings('en-US') } });
  const uri = `inmemory://policy/${DOMAIN}.aster`;
  c.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'aster-cnl', version: 1, text: DOC } });
  return parseCanonicalPreview(await c.request('aster/canonicalPreview', { textDocument: { uri } }));
}

describe('en-US 策略的词汇规范预览（真实语言服务器）', () => {
  it('★带领域词汇：Motorist → Driver、years → age，每个 mapping 的 preview 区间即规范名', async () => {
    const p = await preview([VOCAB]);
    expect(p).not.toBeNull();
    expect(p!.text).toBe(DOC.replace(/Motorist/g, 'Driver').replace(/years/g, 'age'));
    expect(p!.mappings.map((m) => m.canonical)).toEqual(['Driver', 'age', 'Driver', 'age']);
    const at = DOC.indexOf('Motorist');
    expect(p!.mappings[0]!.source).toEqual([at, at + 'Motorist'.length]);
    for (const m of p!.mappings) expect(p!.text.slice(...m.preview)).toBe(m.canonical);
  });

  it('无词汇：预览原样、mappings 为空', async () => {
    const p = await preview(undefined);
    expect(p).not.toBeNull();
    expect(p!.text).toBe(DOC);
    expect(p!.mappings).toEqual([]);
  });
});
