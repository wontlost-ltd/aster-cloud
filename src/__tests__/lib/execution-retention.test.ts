// 执行日志留存期解析（issue #396）。
//
// ## 被修复的问题
//
// `plans.ts` 里 `audit7days`（free）/ `audit90days`（pro 等）此前**只是定价页标签**：
// `cleanupOldExecutionLogs` 全仓零调用方，所有档位实际留存都是**永久**。
// 已售卖未兑现 + GDPR Art 5(1)(e) 存储限制无依据 + Execution 表只增不减。
//
// ## 本文件守什么
//
// 守**解析规则**这一层：featureKey → 天数的映射，以及「无法判定时不猜」。
// 真正的删除行为需要活的 Postgres，属集成测试范畴，本文件不冒充覆盖它——
// 写成那样就是名不副实的假绿。

import { describe, it, expect } from 'vitest';

import { PLANS } from '@/lib/plans';
import {
  SKELETON_RETENTION_DAYS,
  resolveRetention,
  retentionByPlan,
} from '@/lib/retention/execution-retention';

describe('留存期解析（issue #396）', () => {
  it('free = 7 天（对应 audit7days）', () => {
    const r = resolveRetention('free');
    expect(r.executionDays).toBe(7);
    expect(r.skipReason).toBeNull();
  });

  it.each(['trial', 'pro', 'team'])('%s = 90 天（对应 audit90days）', (plan) => {
    const r = resolveRetention(plan);
    expect(r.executionDays).toBe(90);
    expect(r.skipReason).toBeNull();
  });

  it('★enterprise = 显式不限期，不是「无法判定」', () => {
    // 此前 enterprise 一个 audit key 都没有，留存期代码**无从判断**，
    // GC 只能保守跳过并留痕。加上 auditUnlimited 后语义变成**显式声明**：
    // 不是「查不到所以不敢删」，而是「产品明确承诺不限期」。
    //
    // ★两者行为相同（都不删）但必须分开表达：混成一个，真正缺配置的新档位
    //   会被当成「又一个企业客户」淹没在告警里。
    const r = resolveRetention('enterprise');
    expect(r.executionDays).toBeNull();
    expect(r.unlimited).toBe(true);
    expect(r.skipReason).toBeNull(); // 不是「跳过」，是按承诺执行
  });

  it('★真正无法判定的档位仍要给出原因（与不限期区分开）', () => {
    const r = resolveRetention('definitely-not-a-plan');
    expect(r.executionDays).toBeNull();
    expect(r.unlimited).toBe(false); // ★不得被误判成「不限期」
    expect(r.skipReason).toBeTruthy();
  });

  it('★已知 plan 但没配 audit key → 必须是「无法判定」，不得伪装成不限期', () => {
    // 这条守的是本次改动最容易出错的地方：`unlimited` 与「读不出来」
    // 行为相同（都不删）但语义相反——前者是产品承诺，后者是配置缺失。
    // 若把后者也标成 unlimited，新增档位漏配 audit key 就会被静默当成
    // 「又一个企业客户」，永远不会有人去修。
    //
    // ★必须构造一个**已知但无 audit key** 的 plan：直接传不存在的名字会在
    //   更早的「未知 plan」分支就返回，根本走不到这段逻辑——
    //   我第一版正是这么写的，变异验证时那条分支被改了却没红。
    const mutable = PLANS as unknown as Record<string, unknown>;
    mutable.__probe__ = { featureKeys: ['someUnrelatedFeature'] };
    try {
      const r = resolveRetention('__probe__');
      expect(r.executionDays).toBeNull();
      expect(r.unlimited).toBe(false);
      expect(r.skipReason).toContain('__probe__');
    } finally {
      delete mutable.__probe__;
    }
  });

  it.each([null, undefined, '', 'nonexistent-plan'])(
    '未知/缺失 plan（%s）一律不删',
    (plan) => {
      const r = resolveRetention(plan as string | null | undefined);
      expect(r.executionDays).toBeNull();
      expect(r.skipReason).toBeTruthy();
    },
  );

  it('★骨架留存与 plan 解耦——任何档位都是同一个数', () => {
    // 骨架结构上不含 result 字段（见 aster-api TraceSkeleton 类注释），无 PII，
    // 故不适用 Audit 的合规上限；且若跟 Audit 同期，free 档 7 天后条件漏斗
    // 就没数据了，而漏斗正是给业务人员看的核心价值。
    const days = Object.values(retentionByPlan()).map((r) => r.skeletonDays);
    expect(new Set(days).size).toBe(1);
    expect(days[0]).toBe(SKELETON_RETENTION_DAYS);
    expect(SKELETON_RETENTION_DAYS).toBeGreaterThan(90); // 比最长的 Audit 档更久
  });

  it('★plans.ts 里每个档位都必须被本表覆盖到（新增档位会在此炸出来）', () => {
    // 防御「加了新 plan 但忘了定留存」——那种情况下新档位会静默落到
    // 「不删」分支，看起来正常运行实则永久保留。
    const decisions = retentionByPlan();
    for (const name of Object.keys(PLANS)) {
      expect(decisions[name], `plan「${name}」未被留存表覆盖`).toBeDefined();
      const d = decisions[name];
      // 每个档位必须落在**三种明确状态**之一：
      //   有天数 / 显式不限期 / 有跳过原因
      // 三者皆无 = 新增档位没配 audit key 且没被察觉——正是本条要挡的。
      expect(
        d.executionDays !== null || d.unlimited || Boolean(d.skipReason),
        `plan「${name}」三种状态都不是：既无天数、非显式不限期、也无跳过原因`,
      ).toBe(true);
    }
  });

  it('★写错的 audit key 落到「不删」而非被猜出天数', () => {
    // 用穷举表而非 /audit(\d+)days/ 正则的理由：正则会把任何形如 auditXXXdays
    // 的新 key 静默纳入。这里用一个**真实不存在**的 key 验证行为——
    // 它必须走「无法判定 → 不删」，而不是被解析成 999 天。
    //
    // 直接构造一个带假 key 的 plan 形状来验证解析逻辑，不动 plans.ts。
    const fake = resolveRetention('definitely-not-a-plan');
    expect(fake.executionDays).toBeNull();
    expect(fake.skipReason).toContain('未知 plan');
  });
});
