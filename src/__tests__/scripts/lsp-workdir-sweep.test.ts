// @vitest-environment node
/**
 * 网关每连接工作目录的过期清理（sweepStaleWorkDirs）。
 *
 * ★容器被 SIGKILL / OOM 时子进程的 exit 回调来不及执行，aster-lsp-* 目录留在 /tmp；
 *   /tmp 是 emptyDir，容器重启后仍在。启动时按 owner 进程判定并清理。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepStaleWorkDirs } from '../../../lsp-server.mjs';

let root: string;
const mk = (name: string, ownerPid?: number) => {
  const dir = join(root, name);
  mkdirSync(dir);
  if (ownerPid !== undefined) writeFileSync(join(dir, '.owner-pid'), String(ownerPid));
  return dir;
};
/** 拿一个确定已经退出的进程号 */
const deadPid = () => spawnSync('node', ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf-8' }).stdout.trim();

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'sweep-test-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('sweepStaleWorkDirs', () => {
  it('★按 owner 进程判定：已退出 / 本进程（PID 复用）/ 过旧的遗留目录 才删', () => {
    const dead = mk('aster-lsp-dead', Number(deadPid()));
    const own = mk('aster-lsp-own', process.pid);
    const alive = mk('aster-lsp-alive', process.ppid);
    const legacyOld = mk('aster-lsp-legacy-old');
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(legacyOld, twoHoursAgo, twoHoursAgo);
    const legacyFresh = mk('aster-lsp-legacy-fresh');
    const unrelated = mk('other-dir', Number(deadPid()));

    const removed = sweepStaleWorkDirs(root);

    expect(removed.sort()).toEqual([dead, legacyOld, own].sort());
    for (const d of [dead, own, legacyOld]) expect(existsSync(d)).toBe(false);
    for (const d of [alive, legacyFresh, unrelated]) expect(existsSync(d)).toBe(true);
  });

  it('根目录不存在时不抛错', () => {
    expect(sweepStaleWorkDirs(join(root, 'missing'))).toEqual([]);
  });
});
