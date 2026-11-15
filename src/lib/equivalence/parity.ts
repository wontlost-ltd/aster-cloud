/**
 * 双引擎一致性数据模型与纯函数（/equivalence 页面用）。
 *
 * 数据源是 aster-lang-test 每晚回写的五个 history CSV；本模块只负责
 * 「CSV 文本 → 趋势点 → 页面状态」的纯计算，不做 I/O，便于单测覆盖
 * 空数据 / 过期 / 分歧 / 回退等诚实性判定。拉取逻辑见 ./fetch.ts。
 */

/** 一次测量：分子 value / 分母 total，rate = value / total（0..1）。 */
export type TrendPoint = {
  /** ISO 时间戳（UTC） */
  timestamp: string;
  value: number;
  total: number;
  rate: number;
};

/** 一致率维度：两个引擎是否给出同一结果。 */
export const AGREEMENT_DIMENSIONS = ['parse', 'eval', 'ir'] as const;
export type AgreementDimension = (typeof AGREEMENT_DIMENSIONS)[number];

/** 覆盖率维度：测得够不够（不参与「是否一致」的结论）。 */
export const COVERAGE_DIMENSIONS = ['evalCoverage', 'featureCoverage'] as const;
export type CoverageDimension = (typeof COVERAGE_DIMENSIONS)[number];

export type Dimension = AgreementDimension | CoverageDimension;

export type ParityHistory = Record<Dimension, TrendPoint[]>;

/** nightly 每天 02:00 UTC 运行；超过 72 小时没有新测量即视为过期（容忍一次漏跑）。 */
export const STALE_AFTER_MS = 72 * 3_600_000;

/**
 * 解析 history CSV。各 CSV 列序不同（parse: equivalent，eval/ir: identical，
 * coverage: value），故按表头列名定位；分母固定取 `total` 列。
 * 非法行（时间戳缺失、计数非整数 / 为负 / 分子大于分母）直接丢弃，不让一行脏数据污染整条曲线。
 */
const COUNT_RE = /^\d+$/;

export function parseTrendCsv(text: string): TrendPoint[] {
  const rows = text.trim().split(/\r?\n/);
  if (rows.length < 2) return [];
  const header = rows[0]!.split(',').map((c) => c.trim());
  const tsIdx = header.indexOf('timestamp');
  const totalIdx = header.indexOf('total');
  const valueIdx = ['value', 'identical', 'equivalent'].map((c) => header.indexOf(c)).find((i) => i >= 0) ?? -1;
  if (tsIdx < 0 || totalIdx < 0 || valueIdx < 0) return [];

  const points: TrendPoint[] = [];
  for (const line of rows.slice(1)) {
    const cols = line.split(',');
    const timestamp = cols[tsIdx]?.trim() ?? '';
    const totalRaw = cols[totalIdx]?.trim() ?? '';
    const valueRaw = cols[valueIdx]?.trim() ?? '';
    // 只接受十进制非负整数字面量：Number('') === 0 会把空字段误当成合法计数。
    if (!COUNT_RE.test(totalRaw) || !COUNT_RE.test(valueRaw)) continue;
    const total = Number(totalRaw);
    const value = Number(valueRaw);
    if (!timestamp || Number.isNaN(Date.parse(timestamp))) continue;
    // 计数必须是非负整数且分子不超过分母；否则这一行不可信，宁缺毋滥。
    if (!Number.isInteger(total) || !Number.isInteger(value) || value < 0 || value > total) continue;
    points.push({ timestamp, value, total, rate: total > 0 ? value / total : 0 });
  }
  return points;
}

/**
 * 同一 UTC 日多次测量（nightly + 手动重跑）→ 只保留当天最新一条，按时间升序。
 * 图表与「相对上一次」比较都基于日粒度，避免同日重跑造成锯齿或虚假回退。
 */
export function dedupeByDay(points: TrendPoint[]): TrendPoint[] {
  const byDay = new Map<string, TrendPoint>();
  for (const p of points) {
    const day = p.timestamp.slice(0, 10);
    const existing = byDay.get(day);
    if (!existing || p.timestamp > existing.timestamp) byDay.set(day, p);
  }
  return [...byDay.values()].sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
}

export type DimensionStatus = {
  dimension: Dimension;
  /** 最新测量；无数据时为 null（CSV 拉取失败或为空）。 */
  latest: TrendPoint | null;
  /** 上一天的测量（用于回退判定）。 */
  previous: TrendPoint | null;
  /** 最新一次中两个引擎结果不同的数量（覆盖率维度为「未覆盖」数量）。 */
  gap: number;
  /** 最新 rate 低于上一天。 */
  regressed: boolean;
  /** 本维度最新测量已超过 STALE_AFTER_MS。 */
  stale: boolean;
  /** 本维度最早一次测量（用于「覆盖范围从 X 增长到 Y」）。 */
  first: TrendPoint | null;
};

/**
 * - empty：三个一致率维度都没有数据
 * - diverged：任一有数据的维度最新一次有分歧（优先于 partial，分歧必须显式呈现）
 * - partial：无分歧，但有维度缺数据——只能说「已加载的检查全部一致」
 * - agree：三个维度都有数据且全部一致
 */
export type ParityVerdict = 'empty' | 'agree' | 'partial' | 'diverged';

export type ParitySummary = {
  verdict: ParityVerdict;
  /** 任一有数据的一致率维度过期。 */
  stale: boolean;
  /** 一致率维度中最新的测量时间（覆盖率不参与）；无数据时为 null。 */
  lastChecked: string | null;
  /** 没有数据的一致率维度（CSV 拉取失败或为空）。 */
  missing: AgreementDimension[];
  /** 过期的一致率维度（最新测量超过 STALE_AFTER_MS）。 */
  staleDimensions: AgreementDimension[];
  /** 过期维度中最旧的最新测量距 now 的整天数；无过期维度时为 null。 */
  staleAgeDays: number | null;
  /**
   * 各一致率维度**最新一次测量**的检查数之和（parse 样本 + eval 用例 + IR 样本）。
   * 各维度的最新测量不保证来自同一次运行，故文案称「最新结果」而非「同一次运行」，
   * 落后于 lastChecked 的维度由卡片单独标出测量日期。
   */
  totalChecks: number;
  /** 各维度最新测量中结果不同的检查数之和。 */
  divergentChecks: number;
  agreement: Record<AgreementDimension, DimensionStatus>;
  coverage: Record<CoverageDimension, DimensionStatus>;
};

function dimensionStatus(dimension: Dimension, raw: TrendPoint[], now: number): DimensionStatus {
  const days = dedupeByDay(raw);
  const latest = days.at(-1) ?? null;
  const previous = days.length > 1 ? days.at(-2)! : null;
  return {
    dimension,
    latest,
    previous,
    first: days[0] ?? null,
    gap: latest ? Math.max(latest.total - latest.value, 0) : 0,
    regressed: !!latest && !!previous && latest.rate < previous.rate,
    stale: !!latest && now - Date.parse(latest.timestamp) > STALE_AFTER_MS,
  };
}

/** 把五条历史汇总成页面需要的全部状态。`now` 由调用方注入，便于测试。 */
export function summarizeParity(history: ParityHistory, now: number): ParitySummary {
  const agreement = Object.fromEntries(
    AGREEMENT_DIMENSIONS.map((d) => [d, dimensionStatus(d, history[d], now)]),
  ) as Record<AgreementDimension, DimensionStatus>;
  const coverage = Object.fromEntries(
    COVERAGE_DIMENSIONS.map((d) => [d, dimensionStatus(d, history[d], now)]),
  ) as Record<CoverageDimension, DimensionStatus>;

  const measured = AGREEMENT_DIMENSIONS.map((d) => agreement[d]).filter((s) => s.latest && s.latest.total > 0);
  const missing = AGREEMENT_DIMENSIONS.filter((d) => !measured.some((s) => s.dimension === d));
  const lastChecked = measured.map((s) => s.latest!.timestamp).sort().at(-1) ?? null;

  const totalChecks = measured.reduce((n, s) => n + s.latest!.total, 0);
  const divergentChecks = measured.reduce((n, s) => n + s.gap, 0);

  const staleDims = measured.filter((x) => x.stale);

  let verdict: ParityVerdict = 'agree';
  if (measured.length === 0) verdict = 'empty';
  else if (divergentChecks > 0) verdict = 'diverged';
  else if (missing.length > 0) verdict = 'partial';

  return {
    verdict,
    stale: measured.some((s) => s.stale),
    lastChecked,
    missing,
    staleDimensions: staleDims.map((x) => x.dimension as AgreementDimension),
    staleAgeDays: staleDims.length
      ? Math.max(...staleDims.map((x) => Math.floor((now - Date.parse(x.latest!.timestamp)) / 86_400_000)))
      : null,
    totalChecks,
    divergentChecks,
    agreement,
    coverage,
  };
}
