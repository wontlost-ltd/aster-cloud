/**
 * check-lsp-inlined.mjs
 *
 * 构建产物检查：策略编辑器的 LSP 接线（悬停 / 跳转 / 签名帮助等）只在
 * NEXT_PUBLIC_LSP_HOST 与 NEXT_PUBLIC_LSP_TOKEN **都在构建期内联**进客户端 chunk 时才会启用
 * （见 src/components/policy/monaco-policy-editor.tsx 的 isLspConfigured：远端网关强制 token，
 * 缺 token 时编辑器不发起连接）。
 *
 * 为什么要查产物而不是查环境变量：NEXT_PUBLIC_* 只在 `next build` 时被替换成字面量，
 * 运行时（Cloudflare Worker 的 vars / secrets）再设置也无效。构建环境缺变量时，chunk 里会残留
 * `process.env.NEXT_PUBLIC_LSP_TOKEN`（压缩后形如 `B.env.NEXT_PUBLIC_LSP_TOKEN`），浏览器里
 * 读到 undefined —— 2026-10-30 生产复测 A4 就是这样：host 已内联、token 残留，编辑页从不建立 WebSocket。
 *
 * 判定：
 *   - 产物中必须存在 LSP 客户端（含 `/lsp?locale=` 的 chunk），否则视为检查空转；
 *   - 任何 .js 产物中都不得残留 `env.NEXT_PUBLIC_LSP_HOST` / `env.NEXT_PUBLIC_LSP_TOKEN`。
 * 只输出变量名，绝不打印 token 值。
 *
 * 退出码：0 = 通过；1 = 未内联或产物缺失。
 *
 * 用法：node scripts/check-lsp-inlined.mjs [chunk 目录，默认 .next/static/chunks]
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** 必须在构建期内联的变量（顺序即报告顺序）。 */
export const REQUIRED_LSP_ENV = ['NEXT_PUBLIC_LSP_HOST', 'NEXT_PUBLIC_LSP_TOKEN'];

/** LSP 客户端 URL 拼接处的稳定特征（useAsterLSP 的 `/lsp?locale=`）。 */
const LSP_CLIENT_MARKER = '/lsp?locale=';

/**
 * 检查一组 chunk 源码。
 * @param {readonly string[]} sources
 * @returns {{ ok: boolean, hasLspClient: boolean, missing: string[] }}
 */
export function inspectLspInlining(sources) {
  const hasLspClient = sources.some((s) => s.includes(LSP_CLIENT_MARKER));
  const missing = REQUIRED_LSP_ENV.filter((name) => sources.some((s) => s.includes(`env.${name}`)));
  return { ok: hasLspClient && missing.length === 0, hasLspClient, missing };
}

function listJsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listJsFiles(path);
    return entry.name.endsWith('.js') ? [path] : [];
  });
}

/** 递归检查目录下的全部 .js 产物。 */
export function inspectChunkDir(dir) {
  return inspectLspInlining(listJsFiles(dir).map((file) => readFileSync(file, 'utf-8')));
}

const isMain = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const dir = process.argv[2] ?? join(root, '.next', 'static', 'chunks');
  if (!existsSync(dir)) {
    console.error(`::error::找不到构建产物目录 ${dir}，请先运行 next build`);
    process.exit(1);
  }
  const result = inspectChunkDir(dir);
  if (!result.hasLspClient) {
    console.error('::error::构建产物中没有 LSP 客户端（未找到 /lsp?locale=），检查无法进行');
    process.exit(1);
  }
  if (result.missing.length > 0) {
    console.error(
      `::error::以下变量没有在构建期内联，编辑器不会连接 LSP（悬停/跳转不可用）：${result.missing.join(', ')}。` +
        '请在构建环境中设置它们（CI：deploy-worker.yml 的 Build + deploy 步骤）。',
    );
    process.exit(1);
  }
  console.log('✓ LSP host 与 token 已内联进客户端产物，编辑器会发起 LSP 连接');
}
