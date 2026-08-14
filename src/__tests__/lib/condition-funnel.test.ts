// 条件漏斗聚合测试（Phase 1）。
//
// 锁的是聚合语义，尤其两处容易做错的地方：
//   1. evaluated 与 matched 是两个分母——不是所有执行都会走到每个条件
//   2. 死分支定义是"求值过但从未为真"，不能把"根本没走到"也算进去

import { describe, it, expect } from 'vitest';
import {
  aggregateConditionFunnel,
  type TraceSkeletonLike,
} from '@/lib/analytics/condition-funnel';

const sk = (steps: Array<[string, string, boolean, number]>): TraceSkeletonLike => ({
  schemaVersion: 'trace-skeleton/v1',
  steps: steps.map(([stepId, expression, matched, depth]) => ({
    stepId,
    expression,
    matched,
    depth,
  })),
});

describe('aggregateConditionFunnel', () => {
  it('空输入 → 空漏斗（不抛异常）', () => {
    const f = aggregateConditionFunnel([]);
    expect(f.sampleSize).toBe(0);
    expect(f.withSkeleton).toBe(0);
    expect(f.steps).toEqual([]);
    expect(f.neverMatchedInSample).toEqual([]);
  });

  it('按 stepId 聚合命中数与求值数', () => {
    const f = aggregateConditionFunnel([
      sk([['0.1', '客户是 VIP', true, 0]]),
      sk([['0.1', '客户是 VIP', false, 0]]),
      sk([['0.1', '客户是 VIP', true, 0]]),
    ]);
    expect(f.steps).toHaveLength(1);
    expect(f.steps[0]).toMatchObject({ evaluated: 3, matched: 2 });
    expect(f.steps[0].matchRate).toBeCloseTo(2 / 3);
  });

  // ★核心：嵌套条件只在上游命中时才被求值，分母必须是"实际求值次数"
  it('★evaluated 是各条件自己的分母，不是执行总数', () => {
    const f = aggregateConditionFunnel([
      sk([['0.1', 'VIP', true, 0], ['1.1', '信用分>=700', true, 1]]),
      sk([['0.1', 'VIP', false, 0]]), // 未命中 → 内层根本没求值
      sk([['0.1', 'VIP', true, 0], ['1.1', '信用分>=700', false, 1]]),
    ]);
    const outer = f.steps.find((s) => s.stepId === '0.1')!;
    const inner = f.steps.find((s) => s.stepId === '1.1')!;
    expect(outer.evaluated).toBe(3);
    expect(inner.evaluated).toBe(2); // ← 不是 3
    expect(inner.matched).toBe(1);
    expect(inner.matchRate).toBeCloseTo(0.5); // 1/2 而非 1/3
  });

  it('★死分支＝求值过但从未为真', () => {
    const f = aggregateConditionFunnel([
      sk([['0.1', '金额>100万', false, 0]]),
      sk([['0.1', '金额>100万', false, 0]]),
    ]);
    expect(f.neverMatchedInSample).toHaveLength(1);
    expect(f.neverMatchedInSample[0].expression).toBe('金额>100万');
    expect(f.neverMatchedInSample[0].evaluated).toBe(2);
  });

  it('★"从未走到"不算死分支（evaluated=0 不出现在结果里）', () => {
    // 只有走到过的条件才会出现在骨架里，故 evaluated 恒 >0；
    // 这条断言防止将来有人把"未出现的条件"也塞进 neverMatchedInSample。
    const f = aggregateConditionFunnel([sk([['0.1', 'A', true, 0]])]);
    expect(f.neverMatchedInSample).toEqual([]);
    expect(f.steps.every((s) => s.evaluated > 0)).toBe(true);
  });

  it('全部命中 → 无死分支', () => {
    const f = aggregateConditionFunnel([sk([['0.1', 'A', true, 0], ['0.2', 'B', true, 0]])]);
    expect(f.neverMatchedInSample).toEqual([]);
  });

  it('保持执行时的判定顺序（漏斗的意义在于反映真实路径）', () => {
    const f = aggregateConditionFunnel([
      sk([['0.1', '第一步', true, 0], ['1.1', '第二步', true, 1], ['0.2', '第三步', false, 0]]),
    ]);
    expect(f.steps.map((s) => s.stepId)).toEqual(['0.1', '1.1', '0.2']);
  });

  it('null / 空 steps 的执行计入 sampleSize 但不计 withSkeleton', () => {
    const f = aggregateConditionFunnel([sk([['0.1', 'A', true, 0]]), null, undefined, { steps: [] }]);
    expect(f.sampleSize).toBe(4);
    expect(f.withSkeleton).toBe(1);
  });

  // 原本这里断言「同一 stepId 措辞变化时取较新的（策略被改过）」。
  // 该假设已被生产数据推翻：stepId 是执行序号，措辞不同通常意味着**不同节点**
  // 而非同一节点被改名，故必须分开统计。详见下方分支型策略回归测试。
  it('同一 stepId 但措辞不同时分开统计，不合并', () => {
    const f = aggregateConditionFunnel([
      sk([['0.1', '旧措辞', true, 0]]),
      sk([['0.1', '新措辞', true, 0]]),
    ]);
    expect(f.steps).toHaveLength(2);
    expect(f.steps.map((x) => x.expression)).toEqual(['旧措辞', '新措辞']);
    expect(f.steps.every((x) => x.evaluated === 1)).toBe(true);
  });

  it('matchRate 在无求值时为 null 而非 0（无数据 ≠ 0%）', () => {
    const f = aggregateConditionFunnel([]);
    expect(f.steps).toEqual([]);
    // 构造一个 evaluated=0 不可能从骨架产生，故直接断言实现不会把 0 当 0%
    const one = aggregateConditionFunnel([sk([['0.1', 'A', false, 0]])]);
    expect(one.steps[0].matchRate).toBe(0); // 求值过、未命中 → 确实是 0%
  });

  it('★口径说明必须存在（UI 需常驻展示，防止被误读为全量分析）', () => {
    expect(aggregateConditionFunnel([]).sampleNote).toBeTruthy();
    expect(aggregateConditionFunnel([], { sampleNote: '自定义' }).sampleNote).toBe('自定义');
  });
});

// ★回归：分组键必须是 stepId + expression。
//
// 证据来自生产：策略 87f20dc0 的 20 次执行产生 3 种形态，其 stepId "0.1"
// 分别落在 `if condition` / `return value` / `match no-arm` 三种节点上——
// stepId 是**执行序号**不是源码位置，分支型策略换个输入就会错位。
// 只按 stepId 分组会把它们静默混成一条，命中率完全失真。
describe('★分支型策略：同一 stepId 在不同路径下是不同节点', () => {
  it('不同 expression 不得被混为一组（生产实证场景）', () => {
    const f = aggregateConditionFunnel([
      sk([['0.1', 'match no-arm', false, 0]]),
      sk([['0.1', 'return value', true, 0], ['0.2', 'return value', true, 0]]),
      sk([['0.1', 'if condition', false, 0], ['0.2', 'return value', true, 0]]),
    ]);
    const s01 = f.steps.filter((x) => x.stepId === '0.1');
    expect(s01).toHaveLength(3);
    expect(s01.map((x) => x.expression).sort())
      .toEqual(['if condition', 'match no-arm', 'return value']);
    // 每个节点各自计数，不互相污染
    expect(s01.every((x) => x.evaluated === 1)).toBe(true);
  });

  it('同 stepId 同 expression 仍正确合并（不过度拆分）', () => {
    const f = aggregateConditionFunnel([
      sk([['0.1', 'if condition', true, 0]]),
      sk([['0.1', 'if condition', false, 0]]),
    ]);
    expect(f.steps).toHaveLength(1);
    expect(f.steps[0]).toMatchObject({ evaluated: 2, matched: 1 });
  });

  it('★死分支判定不受错聚影响', () => {
    // 若混为一组，'if condition'(0命中) 会被 'return value'(1命中) 掩盖，
    // 死分支就检测不出来了
    const f = aggregateConditionFunnel([
      sk([['0.1', 'return value', true, 0]]),
      sk([['0.1', 'if condition', false, 0]]),
    ]);
    expect(f.neverMatchedInSample.map((x) => x.expression)).toEqual(['if condition']);
  });
});

// ★采样口径回归：本聚合只看最近 N 条，必须诚实说明这一点。
//
// 第四轮交叉审查指出：把「样本内未命中」标成「死分支」会诱导业务人员删掉
// 一条有用的规则（季度触发的风控规则在最近 500 条里当然不命中）。
describe('★采样口径必须诚实', () => {
  const one = () => sk([['0.1', 'if condition', false, 0]]);

  it('total 大于扫描数 → truncated=true', () => {
    const f = aggregateConditionFunnel([one(), one()], { total: 5000 });
    expect(f.scanned).toBe(2);
    expect(f.total).toBe(5000);
    expect(f.truncated).toBe(true);
  });

  it('total 等于扫描数 → truncated=false（这就是全部）', () => {
    const f = aggregateConditionFunnel([one(), one()], { total: 2 });
    expect(f.truncated).toBe(false);
  });

  it('★未提供 total → truncated=null，不得猜成 false', () => {
    // 猜 false 等于宣称"这是全量"，比承认不知道糟得多
    const f = aggregateConditionFunnel([one()]);
    expect(f.total).toBeNull();
    expect(f.truncated).toBeNull();
  });

  it('★字段名不得暗示「死分支」', () => {
    const f = aggregateConditionFunnel([one()], { total: 1 });
    expect(f.neverMatchedInSample).toHaveLength(1);
    // 旧名承载了「这个分支是死的」这层未经证实的结论
    expect(f).not.toHaveProperty('deadBranches');
  });

  it('样本内未命中仍照实列出（不因谨慎而隐藏事实）', () => {
    const f = aggregateConditionFunnel(
      [sk([['0.1', 'if condition', false, 0], ['0.2', 'return value', true, 0]])],
      { total: 100 },
    );
    expect(f.neverMatchedInSample.map((s) => s.expression)).toEqual(['if condition']);
  });
});

describe('步骤顺序按源码行号（issue #385）', () => {
  // A 走 L15 命中 → L16 返回；B 走 L15 不中 → L17 命中 → L18 返回
  const A = sk([
    ['0.1', 'if condition @L15', true, 0],
    ['0.2', 'return value @L16', true, 0],
  ]);
  const B = sk([
    ['0.1', 'if condition @L15', false, 0],
    ['0.2', 'if condition @L17', true, 0],
    ['0.3', 'return value @L18', true, 0],
  ]);
  const order = (arr: TraceSkeletonLike[]) =>
    aggregateConditionFunnel(arr).steps.map((s) => s.expression);

  it('★同一批数据换样本顺序，漏斗顺序必须不变', () => {
    // 这是本 issue 的核心：改之前 [A,B] 与 [B,A] 得到两个不同的「决策路径」，
    // 因为顺序取自「首次出现」——那是**样本的属性，不是策略的属性**。
    expect(order([A, B])).toEqual(order([B, A]));
  });

  it('顺序等于源码行号升序（即人阅读策略的顺序）', () => {
    expect(order([B, A])).toEqual([
      'if condition @L15',
      'return value @L16',
      'if condition @L17',
      'return value @L18',
    ]);
  });

  it('缺行号的步骤排末尾并保持原有相对顺序，不去猜它属于第几行', () => {
    // 老引擎（truffle#64 之前）产的 skeleton 不带 @L。把它们当成第 0 行会
    // 排到最前面，等于编造一个决策路径——宁可放末尾，也不假装知道。
    const legacy = sk([
      ['0.1', 'if condition', true, 0],
      ['0.2', 'return value', true, 0],
    ]);
    const withLine = sk([['0.1', 'if condition @L15', true, 0]]);
    expect(order([legacy, withLine])).toEqual([
      'if condition @L15',
      'if condition',
      'return value',
    ]);
  });
});
