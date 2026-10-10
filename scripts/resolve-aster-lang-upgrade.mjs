/**
 * resolve-aster-lang-upgrade.mjs
 *
 * auto-upgrade.yml 的决策与改写逻辑（拉取模型）：
 *   aster-lang-ts 发版后不再跨 org 推送触发，而是由本仓定时拉取 npm 最新版本，
 *   与 package.json 的钉版比较，决定是否开升级 PR。
 *
 * 子命令：
 *   resolve        读取 REQUESTED_VERSION（可空，空则取 npm latest），判定 skip/upgrade，
 *                  结果写入 $GITHUB_OUTPUT（action / version / branch / reason）。
 *   bump-pins <v>  把 SECONDARY_PINS 中各文件的钉版改成 <v>，与 package.json（由 pnpm add 改写）保持一致。
 *
 * 决策函数是纯函数并导出，供单测覆盖；I/O（npm / gh / 文件）只在 CLI 入口里做。
 * 本脚本在 aster-cloud 与 aster-dev 中保持同一实现，仅 SECONDARY_PINS 按仓配置。
 */

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const DEP = '@aster-cloud/aster-lang-ts';

// package.json 之外还需同步的钉版文件。aster-cloud：独立 LSP 镜像的 lsp-package.json
// 必须与应用精确同版（scripts/check-lsp-pin.mjs 守护）。
export const SECONDARY_PINS = ['lsp-package.json'];

// 只接受 x.y.z（可带预发布后缀）：版本号会进入分支名与 shell，严格校验避免注入与脏分支。
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** 去掉前导 v / 空白；非法返回 null。 */
export function normalizeVersion(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().replace(/^v/, '');
  return VERSION_RE.test(v) ? v : null;
}

/** package.json 里的钉版理论上是精确版本；容忍 ^ ~ = 前缀以免误判。 */
export function stripRange(pin) {
  return normalizeVersion(String(pin ?? '').replace(/^[\^~=]+/, ''));
}

/** 只比较 x.y.z 主体；主体相同时，带预发布后缀的视为更旧。 */
export function compareVersions(a, b) {
  const [coreA, preA] = a.split('-', 2);
  const [coreB, preB] = b.split('-', 2);
  const pa = coreA.split('.').map(Number);
  const pb = coreB.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  if (preA === preB) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  return preA < preB ? -1 : 1;
}

export function branchFor(version) {
  return `deps/aster-lang-ts-v${version}`;
}

/**
 * 判定是否需要开升级 PR。
 *   requested: 手动输入的版本（可空）；空时用 latest（定时任务路径）。
 *   pinned:    package.json 当前钉版。
 *   isPrOpen:  (branch) => boolean，按分支名判断是否已有打开的 PR。
 * 显式指定的版本允许降级（人工意图）；自动解析的 latest 若低于钉版则跳过，避免误开降级 PR。
 */
export function decideUpgrade({ requested, latest, pinned, isPrOpen }) {
  const explicit = typeof requested === 'string' && requested.trim() !== '';
  const version = normalizeVersion(explicit ? requested : latest);
  if (!version) {
    throw new Error(`无效版本号: ${JSON.stringify(explicit ? requested : latest)}`);
  }
  const current = stripRange(pinned);
  if (!current) throw new Error(`package.json 中 ${DEP} 钉版无效: ${JSON.stringify(pinned)}`);

  const branch = branchFor(version);
  if (version === current) {
    return { action: 'skip', version, branch, reason: `already up to date: ${DEP}@${current}` };
  }
  if (!explicit && compareVersions(version, current) < 0) {
    return {
      action: 'skip',
      version,
      branch,
      reason: `npm latest ${version} is older than pinned ${current}; not downgrading automatically`,
    };
  }
  if (isPrOpen(branch)) {
    return { action: 'skip', version, branch, reason: `upgrade PR already open on ${branch}` };
  }
  return { action: 'upgrade', version, branch, reason: `upgrade ${DEP} ${current} -> ${version}` };
}

/** 返回 dependencies 中 aster-lang-ts 钉版改为 version 的新对象（不改动其它字段）。 */
export function bumpPin(pkgJson, version) {
  const v = normalizeVersion(version);
  if (!v) throw new Error(`无效版本号: ${JSON.stringify(version)}`);
  if (typeof pkgJson?.dependencies?.[DEP] !== 'string') {
    throw new Error(`缺少 dependencies["${DEP}"]`);
  }
  return { ...pkgJson, dependencies: { ...pkgJson.dependencies, [DEP]: v } };
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(file) {
  return JSON.parse(readFileSync(join(ROOT, file), 'utf-8'));
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf-8' }).trim();
}

function cliResolve() {
  const pinned = readJson('package.json').dependencies?.[DEP];
  const requested = process.env.REQUESTED_VERSION ?? '';
  // 只有在未显式指定版本时才访问 npm，手动触发路径不依赖 registry 可用性。
  const latest = requested.trim() === '' ? run('npm', ['view', DEP, 'version']) : '';
  const isPrOpen = (branch) =>
    run('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number', '--jq', 'length']) !== '0';

  const result = decideUpgrade({ requested, latest, pinned, isPrOpen });
  console.log(`::notice::${result.reason}`);
  if (process.env.GITHUB_OUTPUT) {
    const lines = ['action', 'version', 'branch', 'reason'].map((k) => `${k}=${result[k]}`);
    appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
  }
}

function cliBumpPins(version) {
  for (const file of SECONDARY_PINS) {
    const next = bumpPin(readJson(file), version);
    writeFileSync(join(ROOT, file), JSON.stringify(next, null, 2) + '\n');
    console.log(`${file} -> ${DEP}@${next.dependencies[DEP]}`);
  }
}

const isMain = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isMain) {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'resolve') cliResolve();
    else if (cmd === 'bump-pins') cliBumpPins(arg);
    else throw new Error('用法: resolve-aster-lang-upgrade.mjs resolve | bump-pins <version>');
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}
