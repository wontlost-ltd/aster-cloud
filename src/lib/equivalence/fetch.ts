/**
 * 服务端拉取 aster-lang-test 的五个 history CSV（ISR，每小时重新验证）。
 *
 * 数据契约与重设计前一致：同样的五个 raw URL、同样的 revalidate 窗口；
 * 任一文件拉取失败只让该维度为空（fail-open），由页面诚实地标注「暂无数据」。
 */
import { parseTrendCsv, summarizeParity, type Dimension, type ParityHistory, type ParitySummary, type TrendPoint } from './parity';

export const PARITY_REPO_URL = 'https://github.com/aster-cloud/aster-lang-test';
const RAW_BASE = 'https://raw.githubusercontent.com/aster-cloud/aster-lang-test/main';
const REVALIDATE_SECONDS = 3600;

/** 每个维度对应的 history CSV 文件名。 */
export const HISTORY_FILES: Record<Dimension, string> = {
  parse: 'equivalence-history.csv',
  eval: 'eval-history.csv',
  ir: 'ir-history.csv',
  evalCoverage: 'eval-coverage-history.csv',
  featureCoverage: 'feature-coverage-history.csv',
};

export const rawFileUrl = (file: string) => `${RAW_BASE}/${file}`;
export const repoFileUrl = (file: string) => `${PARITY_REPO_URL}/blob/main/${file}`;

async function fetchTrend(file: string): Promise<TrendPoint[]> {
  try {
    const res = await fetch(rawFileUrl(file), { next: { revalidate: REVALIDATE_SECONDS } });
    if (!res.ok) return [];
    return parseTrendCsv(await res.text());
  } catch {
    return [];
  }
}

/** 并行拉取全部维度。 */
export async function fetchParityHistory(): Promise<ParityHistory> {
  const dims = Object.keys(HISTORY_FILES) as Dimension[];
  const results = await Promise.all(dims.map((d) => fetchTrend(HISTORY_FILES[d])));
  return Object.fromEntries(dims.map((d, i) => [d, results[i]!])) as ParityHistory;
}

/**
 * 拉取历史并以「当前时间」汇总状态。把取时钟放在数据层而非组件渲染里：
 * 服务端组件保持纯函数，过期判定的时间基准与本次 ISR 渲染一致。
 */
export async function loadParity(): Promise<{ history: ParityHistory; summary: ParitySummary }> {
  const history = await fetchParityHistory();
  return { history, summary: summarizeParity(history, Date.now()) };
}
