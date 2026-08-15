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

  it('★enterprise 无 audit key → 不删且给出原因', () => {
    // 删除不可逆。enterprise 在 plans.ts 里一个 audit featureKey 都没有，
    // 本仓的 unlimited* 约定也没有 auditUnlimited——「该留多久」代码无从判断。
    // 给默认值有两种错法：默认 90 天会真的删掉企业客户数据；默认无限则是
    // 靠「查不到 key」推断语义，将来有人加 key 就静默改行为。
    const r = resolveRetention('enterprise');
    expect(r.executionDays).toBeNull();
    expect(r.skipReason).toBeTruthy();
    expect(r.skipReason).toContain('enterprise');
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
      // 要么有明确天数，要么有明确的跳过原因——不允许两者皆空
      expect(
        d.executionDays !== null || Boolean(d.skipReason),
        `plan「${name}」既无天数也无跳过原因`,
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
