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
 * 与镜像一致的前提：lsp-package.json 的 packageManager 固定 pnpm 版本，
 * Dockerfile.lsp 与 CI 都用 Node 24。本脚本会校验当前 pnpm 版本与之相同。
 *
 * 用法：
 *   node scripts/check-lsp-runtime.mjs
 *
 * 退出码：0 = 握手成功；1 = 安装失败、子进程崩溃、超时或响应不合法。
 */

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;

// 失败时抛出，由顶层统一清理临时目录并以 1 退出。
class GuardError extends Error {
  constructor(message, detail = '') {
    super(message);
    this.detail = detail;
  }
}

function fail(message, detail = '') {
  throw new GuardError(message, detail);
}

// 与 Dockerfile.lsp 的 deps 阶段保持一致：只用 lsp-package.json，--prod --ignore-scripts。
function installLike(dockerfileDir) {
  const lspPackagePath = join(PROJECT_ROOT, 'lsp-package.json');
  const expectedPnpm = /^pnpm@([^+]+)/.exec(JSON.parse(readFileSync(lspPackagePath, 'utf-8')).packageManager ?? '')?.[1];
  if (!expectedPnpm) fail('lsp-package.json must pin pnpm via "packageManager" (same as package.json)');
  const version = spawnSync('pnpm', ['--version'], { encoding: 'utf-8' });
  if (version.error) fail(`cannot run pnpm: ${version.error.message}`);
  if (version.stdout.trim() !== expectedPnpm) {
    fail(`pnpm ${version.stdout.trim()} differs from lsp-package.json packageManager pnpm@${expectedPnpm}`);
  }

  copyFileSync(lspPackagePath, join(dockerfileDir, 'package.json'));
  const res = spawnSync('pnpm', ['install', '--prod', '--ignore-scripts'], {
    cwd: dockerfileDir,
    encoding: 'utf-8',
    timeout: INSTALL_TIMEOUT_MS,
  });
  if (res.error) fail(`pnpm install of lsp-package.json failed: ${res.error.message}`);
  if (res.status !== 0) fail('pnpm install of lsp-package.json failed', `${res.stdout}\n${res.stderr}`);
}

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf-8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

// 读取 id 匹配的响应（Content-Length 分帧），跳过服务端主动发来的通知与请求。
function readResponse(stream, id) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    stream.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const headerEnd = buf.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const length = Number(/Content-Length:\s*(\d+)/i.exec(buf.subarray(0, headerEnd).toString())?.[1]);
        const start = headerEnd + 4;
        if (buf.length < start + length) return;
        const message = JSON.parse(buf.subarray(start, start + length).toString());
        buf = buf.subarray(start + length);
        if (message.id === id && !('method' in message)) return resolve(message);
      }
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
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ timedOut: true });
    }, TIMEOUT_MS);
  });

  // 无论成功失败都清掉计时器并结束子进程，避免失败路径空等到超时。
  try {
    child.stdin.write(
      frame({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { processId: null, rootUri: null, capabilities: {} },
      }),
    );
    const first = await Promise.race([
      readResponse(child.stdout, 1),
      exited.then((code) => ({ exitedEarly: code })),
      timedOut,
    ]);
    if (first.timedOut) fail(`LSP handshake timed out after ${TIMEOUT_MS}ms`, stderr);
    if ('exitedEarly' in first) fail(`LSP server exited (code ${first.exitedEarly}) before answering initialize`, stderr);
    if (first.error || !first.result?.capabilities) fail(`initialize returned no capabilities: ${JSON.stringify(first)}`, stderr);

    child.stdin.write(frame({ jsonrpc: '2.0', id: 2, method: 'shutdown' }));
    child.stdin.write(frame({ jsonrpc: '2.0', method: 'exit' }));
    const end = await Promise.race([exited, timedOut]);
    if (end?.timedOut) fail(`LSP server did not exit within ${TIMEOUT_MS}ms after shutdown`, stderr);
    if (end !== 0) fail(`LSP server exited with code ${end} after shutdown`, stderr);
    return Object.keys(first.result.capabilities).length;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

const dir = mkdtempSync(join(tmpdir(), 'lsp-runtime-'));
try {
  installLike(dir);
  const capabilityCount = await handshake(dir);
  console.log(`✓ LSP server starts from lsp-package.json and answers initialize (${capabilityCount} capabilities)`);
} catch (error) {
  console.error(`✗ ${error.message}`);
  if (error instanceof GuardError && error.detail.trim()) console.error(error.detail.trim());
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
