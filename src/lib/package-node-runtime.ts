/**
 * cloud Worker 内的 Node 包复核能力（ADR 0059 P2，修订 3 P2-R5 / P2-R13）。
 *
 * Node 包导出前，cloud 用自身依赖的 aster-lang-ts（≥ 3.3.0 的 `./package-check` 子路径）重编译（E739）并
 * 逐条比对探针（E735），见 package-node-check。版本是否与 aster-api 锁文件 `node.cliVersion` 一致只能在
 * prepare 之后判定（check 响应不带锁文件版本）：不一致时下载路由返回 503 export_runtime_skew，宁可拒绝也不导出
 * 未经比对的包。TS_VERSION 未盖章（从源码直接运行）时为占位值，必然与锁文件不等，同样 fail-closed。
 */
import { TS_VERSION } from '@aster-cloud/aster-lang-ts/package-check';

export interface NodePackageRuntime {
  /** cloud 依赖的 aster-lang-ts 版本，须等于 aster-api 锁文件的 node.cliVersion */
  tsVersion: string;
}

export function nodePackageRuntime(): NodePackageRuntime | null {
  return { tsVersion: TS_VERSION };
}
