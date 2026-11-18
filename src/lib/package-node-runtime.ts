/**
 * cloud Worker 内的 Node 包复核能力（ADR 0059 P2，修订 3 P2-R5 / P2-R13）。
 *
 * Node 包导出前，cloud 要用自身依赖的 ts 编译器与解释器重编译（E739）并逐条比对探针（E735），
 * 这需要 aster-lang-ts ≥ 3.3.0 的 `./package-check` 子路径（P2-R7）。在 C3（T26 / T27，列车门控）
 * 接入之前没有这个能力：返回 null，详情页不显示 Node 选项，下载路由对 target=node 返回 503
 * export_runtime_skew，宁可拒绝也不导出未经比对的包。
 */
export interface NodePackageRuntime {
  /** cloud 依赖的 aster-lang-ts 版本，须等于 aster-api 锁文件的 node.cliVersion */
  tsVersion: string;
}

export function nodePackageRuntime(): NodePackageRuntime | null {
  return null;
}
