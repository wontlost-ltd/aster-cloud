/**
 * check-lsp-runtime.mjs
 *
 * 守卫：按 Dockerfile.lsp 的同一方式安装 lsp-package.json，然后真正拉起
 * 语言服务器子进程并完成一次 LSP initialize 握手。
 *
 * 为什么需要：@aster-cloud/aster-lang-ts 把 vscode-languageserver 系列声明为
 * **可选 peer 依赖**，pnpm 不会自动安装它们。lsp-package.json 曾只列
 * aster-lang-ts 与 ws，于是镜像里的语言服务器一 import 就 ERR_MODULE_NOT_FOUND
 * 退出，浏览器只看到「Connection closed」。check:lsp-pin 只比对版本字符串，
 * 对这类「装得上、跑不起来」的缺口完全隐形，只能靠真实启动来发现。
 *
 * 判定：initialize 必须返回带 capabilities 的 result，shutdown/exit 后退出码为 0。
 *
 * 用法：
 *   node scripts/check-lsp-runtime.mjs
 *
 * 退出码：0 = 握手成功；1 = 安装失败、子进程崩溃、超时或响应不合法。
 */

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 30_000;

function fail(message, stderr = '') {
  console.error(`✗ ${message}`);
  if (stderr.trim()) console.error(stderr.trim());
  process.exit(1);
}

// 与 Dockerfile.lsp 的 deps 阶段保持一致：只用 lsp-package.json，--prod --ignore-scripts。
function installLike(dockerfileDir) {
  copyFileSync(join(PROJECT_ROOT, 'lsp-package.json'), join(dockerfileDir, 'package.json'));
  const res = spawnSync('pnpm', ['install', '--prod', '--ignore-scripts'], {
    cwd: dockerfileDir,
    encoding: 'utf-8',
  });
  if (res.status !== 0) fail('pnpm install of lsp-package.json failed', `${res.stdout}\n${res.stderr}`);
}

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf-8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

// 读取第一条完整的 LSP 消息（Content-Length 分帧）。
function readFirstMessage(stream) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    stream.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const length = Number(/Content-Length:\s*(\d+)/i.exec(buf.subarray(0, headerEnd).toString())?.[1]);
      const start = headerEnd + 4;
      if (buf.length >= start + length) resolve(JSON.parse(buf.subarray(start, start + length).toString()));
    });
  });
}

async function handshake(dir) {
  // 路径与 lsp-server.mjs 中 lspServerPath 一致。
  const serverPath = join(dir, 'node_modules', '@aster-cloud', 'aster-lang-ts', 'dist', 'src', 'lsp', 'server.js');
  const child = spawn('node', [serverPath, '--stdio'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    fail(`LSP handshake timed out after ${TIMEOUT_MS}ms`, stderr);
  }, TIMEOUT_MS);

  child.stdin.write(
    frame({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { processId: null, rootUri: null, capabilities: {}, initializationOptions: { locale: 'en-US' } },
    }),
  );
  const first = await Promise.race([readFirstMessage(child.stdout), exited.then((code) => ({ exitedEarly: code }))]);
  if ('exitedEarly' in first) fail(`LSP server exited (code ${first.exitedEarly}) before answering initialize`, stderr);
  if (first.error || !first.result?.capabilities) fail(`initialize returned no capabilities: ${JSON.stringify(first)}`, stderr);

  child.stdin.write(frame({ jsonrpc: '2.0', id: 2, method: 'shutdown' }));
  child.stdin.write(frame({ jsonrpc: '2.0', method: 'exit' }));
  const code = await exited;
  clearTimeout(timer);
  if (code !== 0) fail(`LSP server exited with code ${code} after shutdown`, stderr);
  return Object.keys(first.result.capabilities).length;
}

const dir = mkdtempSync(join(tmpdir(), 'lsp-runtime-'));
try {
  installLike(dir);
  const capabilityCount = await handshake(dir);
  console.log(`✓ LSP server starts from lsp-package.json and answers initialize (${capabilityCount} capabilities)`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
