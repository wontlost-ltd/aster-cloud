/**
 * 测试用网关进程管理：保证网关及其子进程（假语言服务器）在测试结束时一定被杀掉，
 * 包括断言失败、超时、worker 退出等路径。
 *
 * ★曾出现孤儿网关（父进程已是 PID 1）：用例在 kill 之前断言失败，网关就一直留着；
 *   而只杀网关本身时，它 spawn 的假语言服务器也会成为孤儿。
 *   做法：网关以独立进程组启动（detached），清理时对整个进程组发 SIGKILL 并等待确认退出；
 *   测试进程本身被强杀时（任何回调都不执行），网关靠预加载的 die-with-parent 自行退出，
 *   假语言服务器在 stdin 关闭时退出。
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DIE_WITH_PARENT = pathToFileURL(join(__dirname, 'die-with-parent.mjs')).href;

const tracked = new Set<ChildProcess>();

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL'); // 负 PID = 整个进程组（网关 + 假语言服务器）
  } catch {
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
}

// worker 正常或异常退出时同步兜底（exit 回调里只能做同步操作）
process.once('exit', () => { for (const c of tracked) killGroup(c); });

/** 以独立进程组启动网关，并登记以便统一清理 */
export function spawnGateway(args: string[], options: SpawnOptions): ChildProcess {
  // 预加载 die-with-parent：测试进程被强杀时（exit 回调不会执行）网关也随之退出
  const child = spawn('node', ['--import', DIE_WITH_PARENT, ...args], { ...options, detached: true });
  tracked.add(child);
  child.once('exit', () => tracked.delete(child));
  return child;
}

const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/** 杀掉指定网关的进程组，并等待其首进程确认退出 */
export async function killGateways(children: readonly ChildProcess[], timeoutMs = 5_000): Promise<void> {
  const pids = children.map((c) => c.pid).filter((p): p is number => p !== undefined);
  for (const c of children) killGroup(c);
  const deadline = Date.now() + timeoutMs;
  while (pids.some(isAlive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  for (const c of children) tracked.delete(c);
}

/** 杀掉所有仍登记的网关进程组 */
export async function killAllGateways(timeoutMs = 5_000): Promise<void> {
  await killGateways([...tracked], timeoutMs);
}

/** 当前仍在跟踪的网关数（供测试自检） */
export function trackedGatewayCount(): number {
  return tracked.size;
}
