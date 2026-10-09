import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * What-If 执行窗口拉取端点（ADR 0034 §3.0）。
 *
 * ★这是个**内部端点**，返回的是历史执行的 `input`——客户的明文业务数据。
 * 故本文件的重点不是「查询对不对」，而是**三道边界**：
 *   1. 无共享密钥 → 503（fail-closed，不是放行）
 *   2. 验签失败 → 401
 *   3. 查询**必须**带 userId——租户隔离不是可选过滤器
 */

const verifyInternalSignature = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api-signing', () => ({ verifyInternalSignature }));

const captured = vi.hoisted(() => ({ where: undefined as unknown, columns: undefined as unknown }));
const rows = vi.hoisted(() => ({ value: [] as unknown[] }));

vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      executions: {
        findMany: (args: { where: unknown; columns: unknown }) => {
          captured.where = args.where;
          captured.columns = args.columns;
          return Promise.resolve(rows.value);
        },
      },
    },
  },
  executions: new Proxy({}, { get: (_t, p) => `executions.${String(p)}` }),
}));

vi.mock('drizzle-orm', () => ({
  and: (...xs: unknown[]) => ({ op: 'and', xs: xs.filter(Boolean) }),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  gt: (col: unknown, val: unknown) => ({ op: 'gt', col, val }),
  gte: (col: unknown, val: unknown) => ({ op: 'gte', col, val }),
  lt: (col: unknown, val: unknown) => ({ op: 'lt', col, val }),
  asc: (col: unknown) => ({ op: 'asc', col }),
}));

const { GET } = await import('@/app/api/internal/executions/window/route');

const FROM = '2026-07-09T04:00:00.000Z';
const TO = '2026-08-08T04:00:00.000Z';

function req(qs: string) {
  return new Request(`https://x.test/api/internal/executions/window?${qs}`);
}

const validQs = `policyId=p1&userId=u1&from=${FROM}&to=${TO}`;

/** 递归收集 where 树里的 eq 条件，形如 "executions.userId=u1"。 */
function eqPairs(node: unknown, acc: string[] = []): string[] {
  if (!node || typeof node !== 'object') return acc;
  const n = node as { op?: string; xs?: unknown[]; col?: unknown; val?: unknown };
  if (n.op === 'eq') acc.push(`${String(n.col)}=${String(n.val)}`);
  if (Array.isArray(n.xs)) n.xs.forEach((x) => eqPairs(x, acc));
  return acc;
}

describe('GET /api/internal/executions/window', () => {
  beforeEach(() => {
    captured.where = undefined;
    captured.columns = undefined;
    rows.value = [];
    verifyInternalSignature.mockReset();
    verifyInternalSignature.mockResolvedValue({ ok: true });
    process.env.ASTER_PLAN_GATE_HMAC_KEY = 'test-key';
  });

  describe('鉴权边界', () => {
    it('★无共享密钥 → 503（fail-closed，不是放行）', async () => {
      delete process.env.ASTER_PLAN_GATE_HMAC_KEY;
      const res = await GET(req(validQs));
      expect(res.status).toBe(503);
    });

    it('验签失败 → 401', async () => {
      verifyInternalSignature.mockResolvedValue({ ok: false, reason: 'bad signature' });
      const res = await GET(req(validQs));
      expect(res.status).toBe(401);
    });

    it('★验签失败时不得触碰数据库', async () => {
      verifyInternalSignature.mockResolvedValue({ ok: false, reason: 'bad' });
      await GET(req(validQs));
      expect(captured.where).toBeUndefined();
    });
  });

  describe('租户隔离', () => {
    it('★查询必须带 userId 条件', async () => {
      await GET(req(validQs));
      expect(eqPairs(captured.where)).toContain('executions.userId=u1');
    });

    it('★缺 userId → 400，不得退化成全量查询', async () => {
      const res = await GET(req(`policyId=p1&from=${FROM}&to=${TO}`));
      expect(res.status).toBe(400);
      expect(captured.where).toBeUndefined();
    });

    it('缺 policyId → 400', async () => {
      const res = await GET(req(`userId=u1&from=${FROM}&to=${TO}`));
      expect(res.status).toBe(400);
    });
  });

  describe('窗口边界（§3.3）', () => {
    it('★只返回 REPLAYABLE 行', async () => {
      // NON_REPLAYABLE 重跑必然失败，算进 plannedCount 会让批次注定拒答
      await GET(req(validQs));
      expect(eqPairs(captured.where)).toContain('executions.replayabilityStatus=REPLAYABLE');
    });

    it('★窗口左闭右开：from 用 gte、to 用 lt', async () => {
      await GET(req(validQs));
      const w = JSON.stringify(captured.where);
      expect(w).toContain('"gte"');
      expect(w).toContain('"lt"');
    });

    it('from >= to → 400（空窗口是调用方算错边界的信号）', async () => {
      const res = await GET(req(`policyId=p1&userId=u1&from=${TO}&to=${FROM}`));
      expect(res.status).toBe(400);
    });

    it('from == to → 400', async () => {
      const res = await GET(req(`policyId=p1&userId=u1&from=${FROM}&to=${FROM}`));
      expect(res.status).toBe(400);
    });

    it('非法时间戳 → 400', async () => {
      const res = await GET(req(`policyId=p1&userId=u1&from=not-a-date&to=${TO}`));
      expect(res.status).toBe(400);
    });

    it('缺 from/to → 400', async () => {
      expect((await GET(req('policyId=p1&userId=u1'))).status).toBe(400);
    });
  });

  describe('分页', () => {
    it('limit 非法值 → 400（不得把 NaN 透传给 Drizzle）', async () => {
      for (const bad of ['abc', '0', '-1', '5001', '1.5']) {
        const res = await GET(req(`${validQs}&limit=${bad}`));
        expect(res.status, `limit=${bad}`).toBe(400);
      }
    });

    it('满页时给 nextCursor，未满页时为 null', async () => {
      rows.value = Array.from({ length: 2 }, (_, i) => ({ id: `e${i}` }));
      const full = await (await GET(req(`${validQs}&limit=2`))).json();
      expect(full.nextCursor).toBe('e1');

      const partial = await (await GET(req(`${validQs}&limit=5`))).json();
      expect(partial.nextCursor).toBeNull();
    });
  });

  describe('返回字段', () => {
    it('★只返回重跑所需字段，不得整行返回', async () => {
      // 整行返回会把 output/traceJson/metadata 等无关字段也带出去，
      // 扩大内部端点的数据暴露面
      await GET(req(validQs));
      const cols = captured.columns as Record<string, boolean>;
      expect(cols.id).toBe(true);
      expect(cols.input).toBe(true);
      expect(cols.decision).toBe(true);
      // 四态基线（ADR 0043 §5）
      expect(cols.outcome).toBe(true);
      // 不该出现的
      expect(cols.output).toBeUndefined();
      expect(cols.traceJson).toBeUndefined();
      expect(cols.metadata).toBeUndefined();
    });
  });
});
