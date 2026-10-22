import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 安全事件统计的**租户隔离**回归（2026-07-30 审计 P0）。
 *
 * 缺陷：`GET /api/v1/security/stats` 校验了登录态却丢弃 `session.user.id`，
 * 而 `getSecurityEventStats` 的签名里根本没有 userId 参数——条件只有起止时间
 * （调用方可控）。任意登录用户传 `?startDate=1970-01-01` 即可拿到全平台
 * 安全事件统计：总数、按 severity 分布、按 type 分布、错误率。
 *
 * ★这是**已修 bug 的漏修**：兄弟函数 `getSecurityEvents` 已经补了 userId 过滤
 * （见 events/route.ts 里描述同一缺陷的注释），`getSecurityEventStats` 被漏掉。
 * 根因是当时把 userId 做成了**可选**参数——少传一个字段就静默退化成跨租户
 * 全表聚合，而类型检查不报错。
 *
 * 这些用例钉死两件事：
 *  1. userId 缺失时**抛错**，绝不静默返回跨租户数据；
 *  2. 正常调用时 userId 谓词**真的进了 SQL 的 where 条件**（不只是签名上有）。
 */

// 真实调用链是 db.select({...}).from(t).where(cond) 以及
// db.select({...}).from(t).where(cond).groupBy(col)——即 where 的返回值既要能被
// await（thenable），又要能继续 .groupBy()。桩必须复刻这个形状，否则测试根本
// 跑不到真实 SQL 构造路径（假信心）。
const { mockSelect, capturedWhere, groupByRows } = vi.hoisted(() => {
  const capturedWhere: unknown[] = [];
  // 依次分给各 groupBy 查询的返回行（按 severity、按 type）；未设置则为空。
  const groupByRows: unknown[][] = [];
  const makeResult = () => {
    const rows: unknown[] = [];
    const thenable = {
      groupBy: () => Promise.resolve(groupByRows.shift() ?? rows),
      then: (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res),
    };
    return thenable;
  };
  const mockSelect = vi.fn(() => ({
    from: () => ({
      where: (cond: unknown) => {
        capturedWhere.push(cond);
        return makeResult();
      },
    }),
  }));
  return { mockSelect, capturedWhere, groupByRows };
});

vi.mock('@/lib/prisma', () => ({
  db: { select: mockSelect },
  securityEvents: {
    createdAt: 'se.createdAt',
    userId: 'se.userId',
    policyId: 'se.policyId',
    severity: 'se.severity',
    eventType: 'se.eventType',
    details: 'se.details',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ op: 'and', args }),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  gte: (col: unknown, val: unknown) => ({ op: 'gte', col, val }),
  lte: (col: unknown, val: unknown) => ({ op: 'lte', col, val }),
  inArray: (col: unknown, val: unknown) => ({ op: 'inArray', col, val }),
  desc: (col: unknown) => ({ op: 'desc', col }),
  sql: Object.assign(() => ({ op: 'sql' }), { raw: () => ({ op: 'sql' }) }),
}));

const USER = 'user-alice';

/** 递归找出 where 条件树里所有 eq(se.userId, ...) 节点 */
function findUserIdPredicates(node: unknown): Array<{ col: unknown; val: unknown }> {
  const out: Array<{ col: unknown; val: unknown }> = [];
  const walk = (n: unknown): void => {
    if (n === null || typeof n !== 'object') return;
    const rec = n as Record<string, unknown>;
    if (rec.op === 'eq' && rec.col === 'se.userId') {
      out.push({ col: rec.col, val: rec.val });
    }
    if (Array.isArray(rec.args)) rec.args.forEach(walk);
    Object.values(rec).forEach((v) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    });
  };
  walk(node);
  return out;
}

describe('getSecurityEventStats — 租户隔离', () => {
  beforeEach(() => {
    capturedWhere.length = 0;
    groupByRows.length = 0;
    vi.clearAllMocks();
  });

  it('userId 缺失时抛错，不静默跨租户聚合', async () => {
    const { getSecurityEventStats } = await import('../security-event-service');
    await expect(
      // @ts-expect-error 故意省略 userId：模拟漏传的调用方（此前会静默跨租户聚合）。
      // 这条 expect-error 本身就是断言之一——userId 变回可选时它会失效并报
      // "Unused '@ts-expect-error' directive"，从而在类型层拦住退化。
      getSecurityEventStats({
        startDate: new Date('1970-01-01'),
        endDate: new Date(),
      })
    ).rejects.toThrow(/userId 必需/);
  });

  it('userId 为空串时抛错', async () => {
    const { getSecurityEventStats } = await import('../security-event-service');
    await expect(
      getSecurityEventStats({
        userId: '',
        startDate: new Date('1970-01-01'),
        endDate: new Date(),
      })
    ).rejects.toThrow(/userId 必需/);
  });

  it('传入 userId 时，userId 谓词真的出现在 SQL where 条件中', async () => {
    const { getSecurityEventStats } = await import('../security-event-service');
    await getSecurityEventStats({
      userId: USER,
      startDate: new Date('2026-01-01'),
      endDate: new Date('2026-12-31'),
    });

    expect(capturedWhere.length).toBeGreaterThan(0);

    // 每一个下发的 where 条件都必须带上本人 userId——任何一条漏了就是越权读。
    for (const cond of capturedWhere) {
      const preds = findUserIdPredicates(cond);
      expect(preds.length).toBeGreaterThan(0);
      for (const p of preds) {
        expect(p.val).toBe(USER);
      }
    }
  });

  it('类型分布按展示类型聚合：提交审批与审批决策分开计数（F10）', async () => {
    const { getSecurityEventStats } = await import('../security-event-service');
    groupByRows.push(
      [{ severity: 'INFO', count: 5 }],
      [
        { eventType: 'APPROVAL_DECISION', action: 'SUBMIT_FOR_APPROVAL', failed: false, count: 2 },
        { eventType: 'APPROVAL_DECISION', action: null, failed: false, count: 3 },
        { eventType: 'POLICY_EXECUTED', action: null, failed: true, count: 1 },
        { eventType: 'POLICY_EXECUTED', action: null, failed: null, count: 4 },
      ],
    );
    const stats = await getSecurityEventStats({
      userId: USER,
      startDate: new Date('2026-01-01'),
      endDate: new Date('2026-12-31'),
    });
    expect(stats.byType).toEqual({
      APPROVAL_SUBMITTED: 2,
      APPROVAL_DECISION: 3,
      POLICY_EXECUTION_FAILED: 1,
      POLICY_EXECUTED: 4,
    });
  });
});
