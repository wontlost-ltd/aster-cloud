/**
 * 本地栈浏览器 E2E 公共辅助：storageState 路径、生产防护、psql 查询。
 * 仅服务于 local-stack 目录下的用例，不得被生产冒烟用例引用。
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// 只在 BASE_CLOUD 指向 localhost 时运行，杜绝误打生产
export const NOT_LOCAL = !process.env.BASE_CLOUD?.includes('localhost');
export const NOT_LOCAL_REASON = '仅针对本地 aster-cloud 栈（BASE_CLOUD 需包含 localhost）';

// 会话夹具目录，由 scripts/e2e-local-session.ts 在容器内生成
const STATE_DIR = process.env.E2E_STATE_DIR || join(process.cwd(), '.superpowers/e2e-local');

export function stateFor(user: 'm-free' | 'm-dpo' | 'owner1' | 't1'): string {
  return join(STATE_DIR, `state-${user}.json`);
}

const PODMAN = process.env.PODMAN_BIN || '/opt/podman/bin/podman';

/** 在 aster-pg 容器里执行只读/校验用 SQL，返回去空白的单行文本结果。 */
export function psql(db: 'aster_cloud' | 'aster_policy', sql: string): string {
  return execFileSync(PODMAN, ['exec', 'aster-pg', 'psql', '-U', 'postgres', '-d', db, '-Atc', sql], {
    encoding: 'utf8',
  }).trim();
}
