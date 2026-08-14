/**
 * 条件漏斗聚合（Phase 1）——纯函数，无 DB / 无 React。
 *
 * <p>把一批 {@link TraceSkeletonLike} 聚合成业务人员看得懂的漏斗：
 * 每个条件被判定为真的次数、占比，以及**从未命中过的条件**（死分支）。
 *
 * <p><b>为什么它是零 PII 的</b>：骨架里只有条件原文（策略源码片段）与布尔
 * 判定，没有任何字段值。聚合只做计数，不碰业务数据。因此本能力对**全部租户**
 * 可用，不受 `replayRetentionEnabled`（默认关）门控。
 *
 * <p><b>★样本口径</b>：分母是"平台记录到的执行"，**不是客户的全量业务数据**。
 * 平台不持有客户订单/客户/交易表（见 docs/strategy-replay-gap-analysis.md 第二节）。
 * {@link ConditionFunnel.sampleNote} 必须被 UI 常驻展示——不加标注地呈现漏斗，
 * 会让业务人员误以为是全量分析，这在风控场景下是危险误导。
 *
 * <p>抽成纯函数是为了能脱离 DB 逐条断言聚合语义（见同名 .test.ts）。
 */

/** 骨架步骤（与 aster-api TraceSkeleton.SkeletonStep 对齐；★无 result 字段）。 */
export interface SkeletonStepLike {
  stepId: string;
  expression: string;
  matched: boolean;
  depth: number;
}

/** 单次执行的骨架。 */
export interface TraceSkeletonLike {
  schemaVersion?: string;
  moduleName?: string | null;
  functionName?: string | null;
  steps: SkeletonStepLike[];
}

/** 聚合后的单个条件。 */
export interface FunnelStep {
  stepId: string;
  /** 条件原文（策略源码片段）。 */
  expression: string;
  depth: number;
  /** 该条件被**求值**过的次数（分母：不是所有执行都会走到每个条件）。 */
  evaluated: number;
  /** 其中判定为真的次数。 */
  matched: number;
  /** matched / evaluated，evaluated=0 时为 null（不是 0——无数据 ≠ 0%）。 */
  matchRate: number | null;
}

export interface ConditionFunnel {
  /** 参与聚合的执行条数。 */
  sampleSize: number;
  /** 其中带骨架的条数——两者不等说明部分执行未采集到骨架。 */
  withSkeleton: number;
  /** ★口径说明，UI 必须展示。 */
  sampleNote: string;
  steps: FunnelStep[];
  /**
   * **在本次样本内**从未判定为真的条件。
   *
   * <p><b>★刻意不叫 deadBranches。</b>本聚合只看最近 N 条执行（见
   * {@link ConditionFunnel.truncated}），「样本内没命中」≠「这个分支是死的」——
   * 一个季度只触发一次的风控规则，在最近 500 条里当然一次都不命中，
   * 但它完全正常。把它标成"死分支"会诱导业务人员去删一条有用的规则。
   *
   * <p>真正的死分支判定需要静态可达性分析（那是 Phase 2 的
   * RuleConflictAnalyzer 在做的事，不需要执行数据），或者全量扫描而非采样。
   * 本字段只陈述事实：这些条件在**这批样本里**没有命中过。
   */
  neverMatchedInSample: FunnelStep[];

  /** 本次实际扫描的执行条数（= sampleSize），与下面的 total 对照看覆盖率。 */
  scanned: number;

  /**
   * 符合筛选条件的执行**总数**；null = 调用方未提供（纯函数无法自己查）。
   *
   * <p>与 {@link scanned} 不等即说明结果基于截断样本。
   */
  total: number | null;

  /** 是否发生了截断（total > scanned）。null = total 未知。 */
  truncated: boolean | null;
}

/** 口径说明的固定文案 key（UI 走 i18n，这里给出稳定标识）。 */
export const SAMPLE_NOTE_KEY = 'analytics.funnel.sampleNote';

/**
 * 聚合一批骨架。
 *
 * <p><b>★分组键是 `stepId + expression`，不是单独的 stepId。</b>
 *
 * <p>原因（生产数据实证）：stepId 是 `<depth>.<sequence>`，即**执行序号**而非
 * 源码位置。分支型策略在不同输入下走不同路径，同一个 stepId 会落到**不同的
 * 源码节点**上。实测某生产策略 20 次执行产生 3 种形态，其 `0.1` 分别是
 * `if condition` / `return value` / `match no-arm` 三种节点——只按 stepId 分组
 * 会把它们静默混成一条，得出的命中率毫无意义。
 *
 * <p>联合 expression 后：不同节点各自成组，语义正确。待引擎补上真实源码文本
 * （见 Core IR span ADR）后，分组会自动变得更精确，本函数无需再改。
 *
 * <p><b>已知局限</b>：当前引擎的 expression 是占位符（`if condition` 等），
 * 故同类型的不同条件仍会被合并。这是**引擎侧的信息缺失**，不是本函数能修的——
 * 但至少不会再把 if 和 return 混为一谈。
 *
 * <p><b>顺序按源码行号</b>（issue #385）。此前按「首次出现顺序」，注释称其为
 * 「执行时的实际判定顺序」——但那是**样本的属性，不是策略的属性**：同一批数据
 * 换个到达顺序，读出的「决策路径」就不同（实测见 sort 处注释）。
 * 行号稳定，且等于人阅读策略的顺序，才真的兑现「反映决策路径」这个承诺。
 */
/**
 * 从 expression 里解出源码行号（引擎产的形如 `if condition @L15`）。
 *
 * <p>老引擎（truffle#64 之前）产的 skeleton 不带 `@L`，此时返回 null——
 * 调用方据此把它排到末尾并保持原有相对顺序，而不是当成第 0 行。
 */
function sourceLineOf(expression: string | undefined | null): number | null {
  if (typeof expression !== 'string') return null;
  const m = /@L(\d+)\s*$/.exec(expression);
  return m ? Number(m[1]) : null;
}

export function aggregateConditionFunnel(
  skeletons: ReadonlyArray<TraceSkeletonLike | null | undefined>,
  opts: { sampleNote?: string; total?: number | null } = {},
): ConditionFunnel {
  const order: string[] = [];
  const acc = new Map<string, FunnelStep>();
  let withSkeleton = 0;

  for (const sk of skeletons) {
    if (!sk || !Array.isArray(sk.steps) || sk.steps.length === 0) continue;
    withSkeleton++;
    for (const step of sk.steps) {
      if (!step || typeof step.stepId !== 'string') continue;
      // ★复合键：见函数注释。仅用 stepId 会把不同路径下的不同节点混为一组。
      const key = `${step.stepId}\u0000${step.expression}`;
      let cur = acc.get(key);
      if (!cur) {
        cur = {
          stepId: step.stepId,
          expression: step.expression,
          depth: step.depth,
          evaluated: 0,
          matched: 0,
          matchRate: null,
        };
        acc.set(key, cur);
        order.push(key);
      }
      cur.evaluated++;
      if (step.matched) cur.matched++;
    }
  }

  const steps = order
    .map((id, firstSeen) => {
      const s = acc.get(id)!;
      return {
        ...s,
        matchRate: s.evaluated > 0 ? s.matched / s.evaluated : null,
        // 排序用，不进对外结构（下方 map 剥掉）
        __line: sourceLineOf(s.expression),
        __firstSeen: firstSeen,
      };
    })
    // ★按源码行号排序，而不是「首次出现顺序」。
    //
    // 首次出现顺序**不是策略的属性，而是样本的属性**：同一批数据换个到达顺序，
    // 漏斗顺序就变。实测（两条走不同分支的执行 A/B）：
    //   [A,B] → @L15 → @L16 → @L17 → @L18
    //   [B,A] → @L15 → @L17 → @L18 → @L16
    // 同样的数据、同样的策略，只因样本顺序不同就读出两条不同的「决策路径」。
    //
    // 行号是源码的属性，稳定且等于人阅读策略的顺序，正是注释承诺的语义。
    // 缺行号的步骤（老引擎产的 skeleton 没有 @L）排在末尾并保持原有相对顺序，
    // 不去猜它该在哪——猜错了就是把编造的顺序当成决策路径展示。
    .sort((a, b) => {
      if (a.__line !== b.__line) {
        if (a.__line === null) return 1;
        if (b.__line === null) return -1;
        return a.__line - b.__line;
      }
      return a.__firstSeen - b.__firstSeen;
    })
    .map(({ __line: _line, __firstSeen: _firstSeen, ...s }) => s);

  const scanned = skeletons.length;
  const total = opts.total ?? null;

  return {
    sampleSize: scanned,
    withSkeleton,
    sampleNote: opts.sampleNote ?? SAMPLE_NOTE_KEY,
    steps,
    scanned,
    total,
    // total 未知时不猜——宁可返回 null 让 UI 说"未知"，也不假装没有截断
    truncated: total === null ? null : total > scanned,
    // 求值过但从未为真。evaluated=0 的不算——那是"没走到"，不是"走到了但不成立"。
    // ★这只是样本内的事实陈述，不等于死分支，命名与文档都不得暗示后者。
    neverMatchedInSample: steps.filter((s) => s.evaluated > 0 && s.matched === 0),
  };
}
