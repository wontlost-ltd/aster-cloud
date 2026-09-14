import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * 复核路由的**写入层四条约束**（ADR 0037 §14/§15）。
 *
 * <p>这四条是整条证据链可信的前提，缺任一条 Proof 就不再是证据：
 *
 * <ol>
 *   <li><b>非授权人不得提交</b>——包括策略**拥有者本人**（除非也被授予资格）</li>
 *   <li><b>机器不得代签</b>——subjectKind 不得为 verifier</li>
 *   <li><b>理由非空</b>——没有理由的批准等于没有复核</li>
 *   <li><b>只 INSERT</b>——撤销＝追加覆盖，不得 UPDATE/DELETE</li>
 * </ol>
 *
 * ★第 1 条里"拥有者也不能签"是刻意的：防"自己写策略、自己签字确认"。
 */

const {
  mockGetSession,
  mockPolicyFindFirst,
  mockReviewerFindFirst,
  mockProofFindMany,
  mockInsertValues,
  mockUpdateWhere,
  mockDeleteWhere,
  mockCheckTeamPermission,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockPolicyFindFirst: vi.fn(),
  mockReviewerFindFirst: vi.fn(),
  mockProofFindMany: vi.fn(),
  mockInsertValues: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockDeleteWhere: vi.fn(),
  mockCheckTeamPermission: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...xs: unknown[]) => ({ op: 'and', xs }),
  desc: (col: unknown) => ({ op: 'desc', col }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  inArray: (col: unknown, vals: unknown) => ({ op: 'inArray', col, vals }),
}));

vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      policies: { findFirst: mockPolicyFindFirst },
      policyReviewers: { findFirst: mockReviewerFindFirst },
      policyProofs: { findMany: mockProofFindMany },
    },
    insert: () => ({ values: mockInsertValues }),
    update: () => ({ set: () => ({ where: mockUpdateWhere }) }),
    delete: () => ({ where: mockDeleteWhere }),
  },
  policies: { id: 'p.id', userId: 'p.userId', teamId: 'p.teamId' },
  policyReviewers: { policyId: 'pr.policyId', userId: 'pr.userId', createdAt: 'pr.createdAt' },
  policyProofs: { id: 'pp.id', policyId: 'pp.policyId', createdAt: 'pp.createdAt' },
  REVIEWER_SUBJECT_KINDS: ['domain_expert', 'engineer'],
}));

vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }));
vi.mock('@/lib/team-permissions', () => ({
  checkTeamPermission: mockCheckTeamPermission,
  TeamPermission: { POLICY_CREATE: 'POLICY_CREATE' },
}));

const PARAMS = { params: Promise.resolve({ id: 'pol1' }) };

/** 允许出现在 Proof 里的身份——机器身份永远不在其中。 */
const REVIEWER_SUBJECT_KINDS_FOR_TEST = ['domain_expert', 'engineer'];

function post(body: unknown): Request {
  return new Request('http://cloud.test/api/policies/pol1/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 一条各字段都合法的结论——各用例只改要测的那一项。 */
const VALID = {
  nodeId: '$.decls{r}.body.statements[0].expr',
  contentHash: 'a'.repeat(64),
  verdict: 'VERIFIED',
  reason: '已与财务核对，金额与业务规则一致。',
  text: '10000',
  // ★span 的起点**必须非零**，且 start / end / text.length 三者互不相等。
  //   全仓原先一律用 `{start:0, end:text.length}`，于是
  //   "原样传递"、"写死 0"、"从 text.length 推导" 三种实现
  //   在测试里数值完全相同——最严格的整行 toEqual 也被夹具废掉。
  //   实测：改成 37/42 后，落库 spanStart 写死 0、队列 span 由 text 推导、
  //   前端提交时重算 span，三个独立缺陷同时报红。
  span: { start: 37, end: 42 },
  // ★必须给一个**非 null** 值：不给的话，"读请求体"和"写死 null"
  //   在断言层面完全不可区分（恒真断言）。
  policyVersionId: 'ver-7',
};

/**
 * 把 drizzle mock 序列化出来的 where 拆成条件列表。
 *
 * <p>`vi.mock('drizzle-orm')` 把 `eq(col,val)` 变成 `{op:'eq',col,val}`，
 * `and(...)` 变成 `{op:'and',xs:[...]}`。
 */
function conditions(where: unknown): { op: string; col: string; val: unknown }[] {
  const w = where as { op?: string; xs?: unknown[] } | undefined;
  if (!w) return [];
  if (w.op === 'and') return (w.xs ?? []).flatMap(conditions);
  return [w as { op: string; col: string; val: unknown }];
}

/** 取某一列的过滤值；该列没有出现在 where 里就返回 undefined。 */
function filterOn(where: unknown, col: string): unknown {
  return conditions(where).find((c) => c.col === col)?.val;
}

/**
 * ★这些 mock 必须**按参数应答**，不能返回罐头值。
 *
 * <p>罐头 mock（`mockResolvedValue(row)`）根本不看传进来的 `where`：
 * 把 `loadReviewer` 里的 `eq(policyReviewers.userId, callerUserId)` 整条删掉，
 * 所有用例照样全绿——而那意味着只要某策略存在**任意一个**复核人，
 * **任何登录用户**都能对它签字。鉴权测试若不检查查询条件，
 * 测的就只是"我让 mock 返回了什么"，而不是"生产代码问了什么"。
 */
function reset() {
  mockGetSession.mockReset().mockResolvedValue({ user: { id: 'u1' } });

  mockPolicyFindFirst.mockReset().mockResolvedValue({
    id: 'pol1', userId: 'owner1', teamId: null, content: 'Module m.',
  });

  mockReviewerFindFirst.mockReset().mockImplementation(
    ({ where }: { where: unknown }) => {
      // 必须同时按 policyId 和 userId 过滤，缺一不可。
      const byPolicy = filterOn(where, 'pr.policyId');
      const byUser = filterOn(where, 'pr.userId');
      return Promise.resolve(byPolicy === 'pol1' && byUser === 'u1'
        // ★授权行的 userId 刻意**不同于** session（模拟去规范化/陈旧列）。
        //   两者同为 'u1' 时，"签字人取自会话"与"取自授权行"不可区分——
        //   而 subjectUserId 是这张 append-only 表里"谁签的字"的唯一记录，
        //   取错就永久固化成另一个人的名字。
        //   注意 where 过滤仍按 'u1' 匹配，鉴权语义不变，变的只是返回行的列值。
        ? { policyId: 'pol1', userId: 'stale-row-user', subjectKind: 'domain_expert' }
        : undefined);
    },
  );
  mockProofFindMany.mockReset().mockResolvedValue([]);
  mockInsertValues.mockReset().mockResolvedValue(undefined);
  mockUpdateWhere.mockReset().mockResolvedValue(undefined);
  mockDeleteWhere.mockReset().mockResolvedValue(undefined);
  mockCheckTeamPermission.mockReset().mockResolvedValue({ allowed: false });
}

describe('复核结论写入 — 四条约束', () => {
  beforeEach(() => { vi.resetModules(); reset(); });
  afterEach(() => vi.restoreAllMocks());

  it('★合法请求应写入一条 Proof（前置：正常路径可用）', async () => {
    const { POST } = await import('@/app/api/policies/[id]/review/route');
    const res = await POST(post(VALID), PARAMS);

    expect(res.status).toBe(200);
    expect(mockInsertValues).toHaveBeenCalledTimes(1);
    const row = mockInsertValues.mock.calls[0]![0] as Record<string, unknown>;

    // ★**整行**比对，不要挑字段。
    //   此前只断言了 subjectUserId / verdict / contentHash 三项，于是
    //   把落库的 reason 换成常量、nodeId 换成 '$.wrong'、text 和 span 归零，
    //   全都不会让任何用例变红。对证据链产品来说这几项正是资产本身：
    //   理由丢了 = 事后无法追溯为什么批准；
    //   nodeId 错了 = 结论挂到别的条款上；
    //   text/span 归零 = 被复核的原文与定位全部失效。
    // ★用 toEqual 而非 toMatchObject。后者是**子集匹配**：只管"我列的字段对不对"，
    //   不管"你还偷偷写了什么"。实测在 insert 里追加调用方可控的
    //   `ruleId / ruleVersion / createdAt` 三个字段，toMatchObject 全绿——
    //   而 `createdAt` 可倒填意味着 resolveEffective（取最新一条）可被操纵：
    //   追加一条 createdAt:'2099-01-01' 的 VERIFIED 就能永久遮住别人的 REJECTED。
    //   对"只 INSERT、永不改写"的证据链，这是最严重的一类篡改。
    expect(row).toEqual({
      id: expect.any(String),          // 服务端生成，值不可预测
      policyId: 'pol1',
      policyVersionId: 'ver-7',
      nodeId: VALID.nodeId,
      contentHash: VALID.contentHash,
      verdict: 'VERIFIED',
      reason: VALID.reason,
      subjectKind: 'domain_expert',
      subjectUserId: 'u1',
      text: '10000',
      spanStart: 37,
      spanEnd: 42,
    });
    // ★`toEqual` **会忽略值为 undefined 的属性**，所以它挡不住
    //   `createdAt: body?.createdAt` 这类"请求体没给就写 undefined"的注入。
    //   必须再用 toStrictEqual 的键集合口径卡一道：落库的键只能是这 12 个。
    //   为什么要紧：`createdAt` 可由调用方倒填 ⇒ resolveEffective（取最新一条）
    //   可被操纵——追加一条 createdAt:'2099-01-01' 的 VERIFIED，
    //   就能永久遮住别人的 REJECTED，而这张表是"只 INSERT、永不改写"的。
    expect(Object.keys(row).sort(), '落库字段集合不得多也不得少').toEqual([
      'contentHash', 'id', 'nodeId', 'policyId', 'policyVersionId', 'reason',
      'spanEnd', 'spanStart', 'subjectKind', 'subjectUserId', 'text', 'verdict',
    ]);
  });

  it('不传 policyVersionId 时应落 null（与上一条配对，锁住"确实读了请求体"）', async () => {
    const { POST } = await import('@/app/api/policies/[id]/review/route');
    const { policyVersionId: _omit, ...withoutVersion } = VALID;
    await POST(post(withoutVersion), PARAMS);

    const row = mockInsertValues.mock.calls[0]![0] as { policyVersionId: unknown };
    expect(row.policyVersionId).toBeNull();
  });

  it('★DB 写入失败必须 500，**绝不能**报 recorded:true', async () => {
    // ★这是整份改动里最重的一条。外层 catch 此前是**死代码**——
    //   `mockInsertValues` 永远 resolve，没有任何用例让写入失败。
    //   若 catch 返回 `recorded:true`（连接池耗尽、约束冲突时很容易这么写），
    //   前端会 setReasons('') 清空理由框并重新 load：
    //   复核人看到理由消失、以为已提交，而审计表里**根本没有这条 Proof**。
    //   对证据链产品，"声称已记录而实际没记"比报错严重得多。
    mockInsertValues.mockRejectedValue(new Error('deadlock detected'));
    const { POST } = await import('@/app/api/policies/[id]/review/route');

    const res = await POST(post(VALID), PARAMS);

    expect(res.status).toBe(500);
    expect(await res.json(), '失败绝不能伪装成成功').not.toMatchObject({ recorded: true });
  });

  it('★会话层抛异常同样 500，不得静默成功', async () => {
    mockGetSession.mockRejectedValue(new Error('session store down'));
    const { POST } = await import('@/app/api/policies/[id]/review/route');

    const res = await POST(post(VALID), PARAMS);

    expect(res.status).toBe(500);
    expect(mockInsertValues, '鉴权都没过不得落库').not.toHaveBeenCalled();
  });

  it('★注入未知字段的**敌意请求**，落库仍只能是那 12 个键', async () => {
    // ★上一版的键集合断言用的是 happy-path fixture（`VALID` 不含这些字段），
    //   于是 `...(body?.createdAt ? { createdAt: body.createdAt } : {})`
    //   这类**条件注入**根本不触发——断言只覆盖"诚实调用方"的形状，
    //   而攻击者恰恰不走那条路径。变量必须是**请求体**，不是实现。
    //
    //   `createdAt` 可倒填的后果最重：resolveEffective 取最新一条，
    //   追加一条 createdAt:'2099-01-01' 的 VERIFIED 就能**永久遮盖**
    //   别人的 REJECTED——而这张表是 append-only 的审计证据。
    const { POST } = await import('@/app/api/policies/[id]/review/route');

    await POST(post({
      ...VALID,
      createdAt: '2099-01-01T00:00:00Z',
      ruleId: 'attacker-rule',
      ruleVersion: '99',
      id: 'forged-id',
      subjectUserId: 'attacker',
      policyId: 'other-policy',
    }), PARAMS);

    const row = mockInsertValues.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(row).sort(), '敌意字段不得进入落库对象').toEqual([
      'contentHash', 'id', 'nodeId', 'policyId', 'policyVersionId', 'reason',
      'spanEnd', 'spanStart', 'subjectKind', 'subjectUserId', 'text', 'verdict',
    ]);
    // 同名字段也不得被请求体夺走
    expect(row.subjectUserId).toBe('u1');
    expect(row.policyId).toBe('pol1');
    expect(row.id).not.toBe('forged-id');
  });

  it('★长理由必须逐字落库，不得被截断', async () => {
    // fixture 的 reason 只有十几个字，`reason.slice(0,200)` 对它是 no-op——
    // 短样本让整行 toEqual 也看不出截断。审计理由动辄数百字。
    const long = '因' + '据《管理办法》第十二条第三款，'.repeat(40) + '故予以确认。';
    expect(long.length, '前置：样本确实够长').toBeGreaterThan(400);
    const { POST } = await import('@/app/api/policies/[id]/review/route');

    await POST(post({ ...VALID, reason: long }), PARAMS);

    expect((mockInsertValues.mock.calls[0]![0] as { reason: string }).reason).toBe(long);
  });

  it('★reason 去首尾空白，但内部原文逐字保留', async () => {
    const { POST } = await import('@/app/api/policies/[id]/review/route');
    await POST(post({ ...VALID, reason: '  金额与 A/B 两处口径一致。  ' }), PARAMS);

    const row = mockInsertValues.mock.calls[0]![0] as { reason: string };
    expect(row.reason).toBe('金额与 A/B 两处口径一致。');
  });

  it('★约束1：非复核人不得提交 —— **即使是策略拥有者**', async () => {
    // 拥有者能看队列，但除非也被授予复核资格，否则不能签字。
    // ★这防的是"自己写策略、自己签字确认"。
    mockGetSession.mockResolvedValue({ user: { id: 'owner1' } });
    mockReviewerFindFirst.mockResolvedValue(undefined);

    const { POST } = await import('@/app/api/policies/[id]/review/route');
    const res = await POST(post(VALID), PARAMS);

    expect(res.status).toBe(403);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('★约束2：机器不得代签 —— 请求体里的 subjectKind 一律不作数', async () => {
    // ★这条的**断言口径变过一次**，值得说明：
    //   原先断言的是"传 verifier → 400"。那验的是**校验分支**。
    //   现在 subjectKind 只取自授权记录，请求体根本不参与——
    //   传 verifier 不再报 400，而是被**忽略**，落库的仍是本人真实身份。
    //   保护更强了（任何冒充身份都无效，不止 verifier 这一个值），
    //   所以断言要对准**结果**（落库的是什么），而不是对准那条校验分支。
    //   只改断言不改口径的话，这里会变成"为了让测试绿而放宽期望"。
    const { POST } = await import('@/app/api/policies/[id]/review/route');
    const res = await POST(post({ ...VALID, subjectKind: 'verifier' }), PARAMS);

    expect(res.status).toBe(200);
    const row = mockInsertValues.mock.calls[0][0] as { subjectKind: string };
    expect(row.subjectKind, '绝不能把机器身份写进 Proof').toBe('domain_expert');
    expect(REVIEWER_SUBJECT_KINDS_FOR_TEST).toContain(row.subjectKind);
  });

  it('★约束3：理由为空/纯空白必须被拒', async () => {
    const { POST } = await import('@/app/api/policies/[id]/review/route');
    for (const reason of ['', '   ', '\n\t']) {
      mockInsertValues.mockClear();
      const res = await POST(post({ ...VALID, reason }), PARAMS);
      expect(res.status, `reason=${JSON.stringify(reason)} 应被拒`).toBe(400);
      expect(mockInsertValues).not.toHaveBeenCalled();
    }
  });

  it('★约束4：只 INSERT —— 永不 UPDATE/DELETE（撤销＝追加覆盖）', async () => {
    const { POST } = await import('@/app/api/policies/[id]/review/route');
    await POST(post(VALID), PARAMS);
    await POST(post({ ...VALID, verdict: 'REJECTED', reason: '复查后推翻。' }), PARAMS);

    expect(mockInsertValues).toHaveBeenCalledTimes(2);
    // ★两次结论都落成新行；旧行不得被改写或删除，否则历史就没了。
    expect(mockUpdateWhere).not.toHaveBeenCalled();
    expect(mockDeleteWhere).not.toHaveBeenCalled();
  });
});

describe('复核结论写入 — 字段完整性', () => {
  beforeEach(() => { vi.resetModules(); reset(); });
  afterEach(() => vi.restoreAllMocks());

  it('★contentHash 必须是 64 位十六进制（时效性判据）', async () => {
    // contentHash 决定 isApplicableTo 能否算出 CONTENT_CHANGED。
    // 格式不对说明调用方没拿到真实指纹——那条 proof 将永远无法判定时效。
    const { POST } = await import('@/app/api/policies/[id]/review/route');
    for (const bad of ['', 'abc', 'A'.repeat(64), 'z'.repeat(64), 'a'.repeat(63)]) {
      mockInsertValues.mockClear();
      const res = await POST(post({ ...VALID, contentHash: bad }), PARAMS);
      expect(res.status, `contentHash=${bad.slice(0, 8)} 应被拒`).toBe(400);
      expect(mockInsertValues).not.toHaveBeenCalled();
    }
  });

  it('★text 长度必须与 span 宽度自洽', async () => {
    // 不自洽说明 span 指向的根本不是这段文本——双向导航会跳错位置。
    const { POST } = await import('@/app/api/policies/[id]/review/route');
    const res = await POST(post({ ...VALID, text: '10000', span: { start: 0, end: 3 } }), PARAMS);

    expect(res.status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('★verdict 只能是 VERIFIED / REJECTED（REVIEW_REQUIRED 是机器的档）', async () => {
    const { POST } = await import('@/app/api/policies/[id]/review/route');
    for (const bad of ['REVIEW_REQUIRED', 'APPROVED', '']) {
      mockInsertValues.mockClear();
      const res = await POST(post({ ...VALID, verdict: bad }), PARAMS);
      expect(res.status, `verdict=${bad} 应被拒`).toBe(400);
      expect(mockInsertValues).not.toHaveBeenCalled();
    }
  });

  it('未登录必须 401，且不触碰数据库', async () => {
    mockGetSession.mockResolvedValue(null);
    const { POST } = await import('@/app/api/policies/[id]/review/route');
    const res = await POST(post(VALID), PARAMS);

    expect(res.status).toBe(401);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });
});

describe('复核结论写入 — 身份与区间的真实性', () => {
  beforeEach(() => { vi.resetModules(); reset(); });
  afterEach(() => vi.restoreAllMocks());

  it('★subjectKind 取自授权记录，**不接受请求体覆盖**', async () => {
    // 被授予 engineer 资格的人若能自称 domain_expert，落库的就是一个
    // 他从未持有的身份。授权记录才是身份来源；请求体只是请求，不是凭据。
    mockReviewerFindFirst.mockResolvedValue({
      policyId: 'pol1', userId: 'u1', subjectKind: 'engineer',
    });
    const { POST } = await import('@/app/api/policies/[id]/review/route');

    const res = await POST(post({ ...VALID, subjectKind: 'domain_expert' }), PARAMS);

    expect(res.status).toBe(200);
    const row = mockInsertValues.mock.calls[0][0] as { subjectKind: string };
    expect(row.subjectKind, '必须落 engineer——他被授予的就是这个').toBe('engineer');
  });

  it('★subjectUserId 必须取会话，不得由请求体指定（防冒名）', async () => {
    const { POST } = await import('@/app/api/policies/[id]/review/route');
    await POST(post({ ...VALID, subjectUserId: 'attacker' }), PARAMS);

    const row = mockInsertValues.mock.calls[0][0] as { subjectUserId: string };
    expect(row.subjectUserId).toBe('u1');
  });

  it('★policyId 只能来自 URL，请求体不得覆盖（防写到别的策略名下）', async () => {
    const { POST } = await import('@/app/api/policies/[id]/review/route');
    await POST(post({ ...VALID, policyId: 'other-policy' }), PARAMS);

    const row = mockInsertValues.mock.calls[0][0] as { policyId: string };
    expect(row.policyId).toBe('pol1');
  });

  it('★span 起点为负必须 400，且不得落库', async () => {
    // 之前只有"text 长度与 span 宽度自洽"一条，恰好把这类输入挡在别处，
    // 于是 start<0 / end<=start 这行校验删掉也不会有任何测试变红。
    // 实测过：span {start:-5,end:0} + text '10000'（长度自洽）能落库成功。
    const { POST } = await import('@/app/api/policies/[id]/review/route');

    const res = await POST(post({ ...VALID, span: { start: -5, end: 0 } }), PARAMS);

    expect(res.status).toBe(400);
    expect(mockInsertValues, '非法 span 不得落库').not.toHaveBeenCalled();
  });

  it('★nodeId 缺失必须 400', async () => {
    const { POST } = await import('@/app/api/policies/[id]/review/route');
    const { nodeId: _o, ...noNode } = VALID;

    expect((await POST(post(noNode), PARAMS)).status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('★nodeId 全是空白同样 400（必须 trim 后判空）', async () => {
    // 空串/纯空白能落库的话，Proof 挂到一个不存在的节点上，
    // resolveEffective 永远找不到它——这次复核凭空蒸发，
    // 但审计表里留着一条"已复核"的记录。
    const { POST } = await import('@/app/api/policies/[id]/review/route');

    expect((await POST(post({ ...VALID, nodeId: '   ' }), PARAMS)).status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('★约束2：授权记录里若是机器身份，必须拒绝落库', async () => {
    // 口径改成"只取授权记录"之后，这条守卫防的是
    // **policyReviewers 表里出现 subjectKind:'verifier' 的行**。
    // 而所有 fixture 的 reviewer 都是 domain_expert/engineer，
    // 于是该守卫一度成为死代码（删掉它没有任何用例变红）。
    mockReviewerFindFirst.mockResolvedValue({
      policyId: 'pol1', userId: 'u1', subjectKind: 'verifier',
    });
    const { POST } = await import('@/app/api/policies/[id]/review/route');

    const res = await POST(post(VALID), PARAMS);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining('机器不得代签'),
    });
    expect(mockInsertValues, '机器身份绝不能落进 Proof').not.toHaveBeenCalled();
  });

  it('★text **短于** span 宽度同样 400（自洽校验须双向）', async () => {
    // 原先只测了 text 长于 span。反方向可写入
    // text:'10000' + span{0,100}：声称复核了 100 个字符，实际只存了 5 个，
    // 双向导航会高亮一大片复核人从没看过的内容。
    const { POST } = await import('@/app/api/policies/[id]/review/route');

    const res = await POST(post({ ...VALID, span: { start: 0, end: 100 } }), PARAMS);

    expect(res.status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('★span 必须是整数（小数同样 400）', async () => {
    // 宽度自洽是关键：5.5-0.5 === 5 恰好等于 text 长度，会绕过宽度校验，
    // 所以这条测的就是 Number.isInteger 那一段本身。
    // 实测过：去掉整数性校验后，该请求会以 200 落库 spanStart:0.5。
    const { POST } = await import('@/app/api/policies/[id]/review/route');

    const res = await POST(post({ ...VALID, span: { start: 0.5, end: 5.5 } }), PARAMS);

    expect(res.status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('★span 终点不大于起点必须 400', async () => {
    const { POST } = await import('@/app/api/policies/[id]/review/route');

    const res = await POST(post({ ...VALID, span: { start: 5, end: 5 }, text: '' }), PARAMS);

    expect(res.status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });
});

/**
 * GET 层：谁能**看**队列，以及队列本身是不是可信的。
 *
 * <p>★这一整块此前**完全没有测试**——`review-route.test.ts` 从不 import GET。
 * 对抗性变异实测：删掉 GET 的鉴权门、删掉 401 门、把 canReview 写死为 true、
 * 把 proofs 查询的 policyId 过滤去掉、把排序改成升序、在 catch 里伪造队列……
 * **以上全部变异都不会让任何测试变红**。
 * 也就是说跨租户读取整条证据链（记录人、理由原文、节点内容）当时零成本。
 *
 * <p>前端测试也覆盖不到它：组件把 fetch 整个 stub 掉，喂的是手写 JSON。
 */
describe('复核队列读取 — GET 授权与契约', () => {
  beforeEach(() => { vi.resetModules(); reset(); });
  afterEach(() => vi.restoreAllMocks());

  function get(): Request {
    return new Request('http://cloud.test/api/policies/pol1/review');
  }

  it('★未登录必须 401', async () => {
    mockGetSession.mockResolvedValue(null);
    const { GET } = await import('@/app/api/policies/[id]/review/route');

    expect((await GET(get(), PARAMS)).status).toBe(401);
  });

  it('★既非拥有者、也非复核人 → 404（不得泄露策略是否存在）', async () => {
    mockPolicyFindFirst.mockResolvedValue({ id: 'pol1', userId: 'someone-else', teamId: null });
    mockReviewerFindFirst.mockResolvedValue(undefined);
    const { GET } = await import('@/app/api/policies/[id]/review/route');

    const res = await GET(get(), PARAMS);
    expect(res.status).toBe(404);
    // 一条 proof 都不该被查询——鉴权必须在读数据之前。
    expect(mockProofFindMany).not.toHaveBeenCalled();
  });

  it('★GET 内部异常必须 500，不得伪装成 queueStatus:ok', async () => {
    // 外层 catch 同样是死代码。把它改成返回 `queueStatus:'ok'` 的空载荷，
    // 就是 143 行注释里明确要防的那种 fail-open——而那条防线自己没被测过。
    mockProofFindMany.mockRejectedValue(new Error('boom'));
    const { GET } = await import('@/app/api/policies/[id]/review/route');

    const res = await GET(get(), PARAMS);

    expect(res.status).toBe(500);
    const body = await res.json() as { queueStatus?: string };
    expect(body.queueStatus, '内部错误不得报成 ok').not.toBe('ok');
  });

  it('★策略不存在 → 404，且不读任何 proof', async () => {
    // 存在性检查此前零覆盖：mockPolicyFindFirst 永远返回一行。
    // 删掉 `if (!policy) return null` 后，对不存在的资源返回 200
    // 就成了一个探测接口。
    mockPolicyFindFirst.mockResolvedValue(undefined);
    const { GET } = await import('@/app/api/policies/[id]/review/route');

    expect((await GET(get(), PARAMS)).status).toBe(404);
    expect(mockProofFindMany).not.toHaveBeenCalled();
  });

  it('★policies 查询必须按 id 过滤（否则拿 A 的 id 可能返回 B）', async () => {
    // ★这条断言的是**生产代码问了什么**，不是 mock 返回了什么。
    //   放在 mockImplementation 里不行：用例级的 mockResolvedValue 会整个
    //   替换掉 implementation，断言就再也不执行了。
    const { GET } = await import('@/app/api/policies/[id]/review/route');
    await GET(get(), PARAMS);

    expect(mockPolicyFindFirst).toHaveBeenCalled();
    const arg = mockPolicyFindFirst.mock.calls[0][0] as { where: unknown } | undefined;
    expect(filterOn(arg?.where, 'p.id'), 'where 必须含 eq(policies.id, :id)').toBe('pol1');
  });

  it('★复核人资格查询必须同时按 policyId 与 userId 过滤', async () => {
    // 只按 policyId 查 ⇒ 只要该策略存在**任意一个**复核人，
    // **任何登录用户**都能通过 403 门去签字。
    const { GET } = await import('@/app/api/policies/[id]/review/route');
    await GET(get(), PARAMS);

    const calls = mockReviewerFindFirst.mock.calls as [{ where: unknown }][];
    expect(calls.length).toBeGreaterThan(0);
    for (const [arg] of calls) {
      expect(filterOn(arg.where, 'pr.policyId')).toBe('pol1');
      expect(filterOn(arg.where, 'pr.userId'), '缺 userId 过滤 = 任何人可签字').toBe('u1');
    }
  });

  it('★团队策略：有 POLICY_CREATE 权限的成员可以看队列', async () => {
    // ★team 分支此前**从未被任何用例执行过**（所有 fixture 的 teamId 都是 null）。
    //   变异实测：把整个分支换成 `return policy`、或删掉 checkTeamPermission 调用，
    //   54 条全绿——任何登录用户都能读团队策略的完整证据链。
    mockPolicyFindFirst.mockResolvedValue({ id: 'pol1', userId: 'owner1', teamId: 't1',
                                            content: 'Module m.' });
    mockReviewerFindFirst.mockResolvedValue(undefined);
    mockCheckTeamPermission.mockResolvedValue({ allowed: true });
    const { GET } = await import('@/app/api/policies/[id]/review/route');

    const res = await GET(get(), PARAMS);

    expect(res.status).toBe(200);
    // 必须**真的问过**权限系统，且问的是这个人、这个团队、这项权限。
    expect(mockCheckTeamPermission).toHaveBeenCalledWith('u1', 't1', 'POLICY_CREATE');
  });

  it('★团队策略：无权限且非复核人 → 404（**即使调用者是 policy.userId**）', async () => {
    // ★fixture 刻意把 policy.userId 设成调用者本人。
    //   原先是 'owner1'（与 session 'u1' 永不相等），于是 owner 回退分支
    //   在 team 场景下从未被触发——把 `else if (policy.userId === caller)`
    //   拆成独立 `if` 就能绕过团队 ACL 而无人察觉。
    //   现实对应：成员已被移出团队，但 policy.userId 仍指向他。
    //   团队策略的授权**只由团队 ACL 决定**。
    mockPolicyFindFirst.mockResolvedValue({ id: 'pol1', userId: 'u1', teamId: 't1',
                                            content: 'Module m.' });
    mockReviewerFindFirst.mockResolvedValue(undefined);
    mockCheckTeamPermission.mockResolvedValue({ allowed: false });
    const { GET } = await import('@/app/api/policies/[id]/review/route');

    const res = await GET(get(), PARAMS);

    expect(res.status).toBe(404);
    expect(mockCheckTeamPermission).toHaveBeenCalled();
    expect(mockProofFindMany, '鉴权未过不得读任何证据').not.toHaveBeenCalled();
  });

  it('★拥有者能看队列，但 canReview 必须是 false —— 看得见 ≠ 能签字', async () => {
    // 防"自己写策略、自己签字确认"。POST 侧锁住了，GET 侧此前没锁：
    // canReview 若恒真，前端就会给拥有者渲染出签字按钮。
    mockPolicyFindFirst.mockResolvedValue({ id: 'pol1', userId: 'u1', teamId: null,
                                            content: 'Module m.' });
    mockReviewerFindFirst.mockResolvedValue(undefined);   // 拥有者未被授予复核资格
    const { GET } = await import('@/app/api/policies/[id]/review/route');

    const res = await GET(get(), PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json() as { canReview: boolean; subjectKind: string | null };
    expect(body.canReview, '拥有者不得自动获得签字资格').toBe(false);
    expect(body.subjectKind).toBeNull();
  });

  it('被授予资格的复核人 canReview 为 true，且回传其 subjectKind', async () => {
    // 反向守卫：别把上一条修成"永远 false"。
    mockPolicyFindFirst.mockResolvedValue({ id: 'pol1', userId: 'owner1', teamId: null,
                                            content: 'Module m.' });
    mockReviewerFindFirst.mockResolvedValue({ policyId: 'pol1', userId: 'u1',
                                              subjectKind: 'engineer' });
    const { GET } = await import('@/app/api/policies/[id]/review/route');

    const body = await (await GET(get(), PARAMS)).json() as
      { canReview: boolean; subjectKind: string };
    expect(body.canReview).toBe(true);
    // ★必须回传**真实**身份。写死 'domain_expert' 会让 engineer 签的字记错类别。
    expect(body.subjectKind).toBe('engineer');
  });

  it('★同一 nodeId 的多条 proof 必须**全部**回传（前端 supersededCount 的唯一输入）', async () => {
    // ★这是一条被前端依赖的隐式契约：面板用 proofs 的条数判断
    //   "该节点是否有更早的结论被覆盖"（supersededNote 徽标）。
    //   GET 的注释说"UI 取每个节点的第一条即当前有效结论"，任何人照这句话
    //   做一次"服务端顺手去重"的优化，计数就恒为 1、徽标永不出现——
    //   而那是撤销/更正场景下唯一的审计提示，会静默消失。
    //   撤销＝追加，被覆盖的旧结论**是审计资产**，不得在传输层丢弃。
    mockPolicyFindFirst.mockResolvedValue({ id: 'pol1', userId: 'u1', teamId: null,
                                            content: 'Module m.' });
    // ★两行**六字段全异**。原来的 mk() 只有 id 和 verdict 变化，
    //   于是"逐行映射"与"全取第一行"不可区分：把 verdict/记录人/理由
    //   串成第一行的值也全绿——而撤销场景下那意味着被覆盖的旧结论
    //   会显示成新结论的内容，审计追溯彻底失效。
    mockProofFindMany.mockResolvedValue([
      { id: 'newer', nodeId: '$.same', contentHash: 'b'.repeat(64), verdict: 'REJECTED',
        reason: '复议后推翻', subjectKind: 'engineer', subjectUserId: 'bob',
        text: '10000', spanStart: 37, spanEnd: 42, createdAt: '2026-09-12T00:00:00Z' },
      { id: 'older', nodeId: '$.same', contentHash: 'e'.repeat(64), verdict: 'VERIFIED',
        reason: '初次通过', subjectKind: 'domain_expert', subjectUserId: 'carol',
        text: '30 days', spanStart: 80, spanEnd: 87, createdAt: '2026-09-11T00:00:00Z' },
    ]);
    const { GET } = await import('@/app/api/policies/[id]/review/route');

    const body = await (await GET(get(), PARAMS)).json() as { proofs: { id: string }[] };

    expect(body.proofs.map((p) => p.id), '服务端不得按 nodeId 去重').toEqual(['newer', 'older']);
    // 逐行整体断言：任一字段串线都会变红。
    expect(body.proofs).toEqual([
      { id: 'newer', nodeId: '$.same', contentHash: 'b'.repeat(64), verdict: 'REJECTED',
        reason: '复议后推翻', subjectKind: 'engineer', subjectUserId: 'bob',
        text: '10000', span: { start: 37, end: 42 }, recordedAt: '2026-09-12T00:00:00Z' },
      { id: 'older', nodeId: '$.same', contentHash: 'e'.repeat(64), verdict: 'VERIFIED',
        reason: '初次通过', subjectKind: 'domain_expert', subjectUserId: 'carol',
        text: '30 days', span: { start: 80, end: 87 }, recordedAt: '2026-09-11T00:00:00Z' },
    ]);
    // limit 同样会截断审计历史。
    const arg = mockProofFindMany.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.limit, 'proofs 查询不得设 limit').toBeUndefined();
  });

  it('★落库 text 必须逐字保留，不得 trim（span 自洽性依赖它）', async () => {
    // CNL 条款文本常带缩进。trim 后 text.length 与 spanEnd-spanStart 不再自洽，
    // 而这正是路由自己强制校验的不变量——审计表里会出现自相矛盾的记录。
    const { POST } = await import('@/app/api/policies/[id]/review/route');

    await POST(post({ ...VALID, text: '  10000  ', span: { start: 37, end: 46 } }), PARAMS);

    expect((mockInsertValues.mock.calls[0]![0] as { text: string }).text).toBe('  10000  ');
  });

  it('★proofs 查询必须按 policyId 过滤，且按 createdAt **降序**', async () => {
    // 前端的 effectiveByNode 取"首次遇到即最新"，完全依赖这个隐式契约。
    // 改成升序，旧的 VERIFIED 就会遮住后来的 REJECTED——结论被悄悄倒退。
    // 去掉 policyId 过滤则是跨策略泄露。
    mockPolicyFindFirst.mockResolvedValue({ id: 'pol1', userId: 'u1', teamId: null,
                                            content: 'Module m.' });
    const { GET } = await import('@/app/api/policies/[id]/review/route');
    await GET(get(), PARAMS);

    expect(mockProofFindMany).toHaveBeenCalledTimes(1);
    const arg = mockProofFindMany.mock.calls[0][0] as
      { where: { op: string; col: string; val: string }; orderBy: { op: string }[] };
    expect(arg.where, 'where 必须是 eq(policyProofs.policyId, id)')
      .toMatchObject({ op: 'eq', col: 'pp.policyId', val: 'pol1' });
    expect(arg.orderBy[0], 'orderBy 首键必须是 desc(createdAt)')
      .toMatchObject({ op: 'desc', col: 'pp.createdAt' });
    // ★必须有第二排序键。只按 createdAt 排时，同一毫秒写入的两条 proof
    //   顺序未定义，前端"取首条即最新"就会在两次刷新之间给出不同的
    //   当前有效结论。第二键不能让并列项按真实先后排序（UUID 随机），
    //   但能保证**顺序稳定**。
    expect(arg.orderBy[1], 'orderBy 必须有确定性 tiebreaker')
      .toMatchObject({ op: 'desc', col: 'pp.id' });
  });

  it('★引擎版本过旧时 queueStatus 必须是 engine_outdated，且队列为空', async () => {
    // 本仓 pin 的 aster-lang-ts 尚不含 runSemanticBridge，所以这条走的就是
    // 生产当前的真实路径。关键是**不能把"不知道"报成"没问题"**：
    // 若 queueStatus 恒为 'ok'，前端会显示"没有待复核项"，
    // 审计员会以为机器都证明完了——而机器根本没跑。
    mockPolicyFindFirst.mockResolvedValue({ id: 'pol1', userId: 'u1', teamId: null,
                                            content: 'Module m.' });
    const { GET } = await import('@/app/api/policies/[id]/review/route');

    const body = await (await GET(get(), PARAMS)).json() as {
      queueStatus: string;
      items: unknown[];
      counts: { verified: number; reviewRequired: number; rejected: number };
    };
    // ★本仓 pin 的 aster-lang-ts@1.0.28 尚无 runSemanticBridge，所以这里走的
    //   就是生产当前的真实路径：**版本过旧**，而非引擎故障。
    expect(body.queueStatus).toBe('engine_outdated');
    // ★与「引擎抛异常 → engine_error」那条配对：两个状态必须**互相可区分**。
    //   把任一方改成另一方（或改成 'ok'），都会有用例变红。
    //   运维含义不同：过旧会随发版列车自愈，故障要有人去看；混为一谈，
    //   线上事故在日志里就长得和"还没发版"一模一样。
    expect(body.queueStatus).not.toBe('engine_error');
    expect(body.queueStatus).not.toBe('ok');
    expect(body.items).toEqual([]);
    expect(body.counts).toEqual({ verified: 0, reviewRequired: 0, rejected: 0 });
  });

  it('已落库的结论必须原样回传（含 verdict / 记录人 / span）', async () => {
    mockPolicyFindFirst.mockResolvedValue({ id: 'pol1', userId: 'u1', teamId: null,
                                            content: 'Module m.' });
    mockProofFindMany.mockResolvedValue([{
      id: 'pr1', nodeId: '$.a', contentHash: 'b'.repeat(64), verdict: 'REJECTED',
      reason: '不符合口径', subjectKind: 'engineer', subjectUserId: 'bob',
      text: '10000', spanStart: 3, spanEnd: 8, createdAt: '2026-09-12T00:00:00Z',
    }]);
    const { GET } = await import('@/app/api/policies/[id]/review/route');

    const body = await (await GET(get(), PARAMS)).json() as
      { proofs: { verdict: string; subjectUserId: string;
                  span: { start: number; end: number }; reason: string }[] };
    // ★整行断言。`contentHash` 与 `nodeId` 尤其要紧——它们是前端
    //   effectiveByNode（按 nodeId 归组）与 stale（比 contentHash）的**唯一输入**。
    //   服务端把 contentHash 换成常量，前端的时效性判定就恒为"未变更"，
    //   等于绕开了前端那几条守卫。
    expect(body.proofs).toEqual([{
      id: 'pr1', nodeId: '$.a', contentHash: 'b'.repeat(64), verdict: 'REJECTED',
      reason: '不符合口径', subjectKind: 'engineer', subjectUserId: 'bob',
      text: '10000', span: { start: 3, end: 8 },
      recordedAt: '2026-09-12T00:00:00Z',
    }]);
  });
});

/**
 * GET 队列的**过滤契约**：只有「机器证不了」且「指纹可用」的候选才进队列。
 *
 * <p>这两条过滤此前都没有测试（M12/M14）：把 verdict 过滤去掉，
 * 机器已经证明过的节点会重新出现在人工队列里——白白消耗复核人的时间，
 * 更糟的是让"机器已证明"这件事失去意义；把 contentHash 过滤去掉，
 * 用户会看到一条点下去必被 400 拒的候选。
 */
describe('复核队列读取 — 队列过滤契约', () => {
  // ★必须 doUnmock：`vi.resetModules()` 只清模块实例，**不清 mock 注册表**。
  //   否则上一条用例装的引擎 mock（比如"抛异常"）会渗到下一条，
  //   让"版本过旧"的用例读到 engine_error —— 测试之间互相污染。
  beforeEach(() => {
    vi.doUnmock('@aster-cloud/aster-lang-ts');
    vi.resetModules();
    reset();
  });
  afterEach(() => vi.restoreAllMocks());

  /** 让动态 import 拿到一个受控的 runSemanticBridge。 */
  function stubEngine(verified: unknown[]) {
    vi.doMock('@aster-cloud/aster-lang-ts', () => ({
      runSemanticBridge: () => ({
        // ★三值**互异**。全是 1 时，verified/reviewRequired/rejected 之间
        //   任意串线、轮换、乃至整体硬编码都不可区分——实测把
        //   `counts: bridge.summary` 换成写死的 {1,1,1}，全仓 6193 条无一变红。
        //   这是 span 全 0 / 队列全单条 / proof 行只差两字段之后的**第四例**
        //   同构塌缩。后果：审计员看到"9 条已证明、0 条被拒"，
        //   实际是"5 条已证明、9 条被拒"。
        summary: { verified: 5, reviewRequired: 2, rejected: 9 },
        verified,
      }),
    }));
  }

  function cand(over: Record<string, unknown> = {}) {
    return {
      mapping: { text: '10000', nodeId: '$.a', span: { start: 37, end: 42 } },
      result: { verdict: 'REVIEW_REQUIRED', reason: '机器证不了' },
      contentHash: 'a'.repeat(64),
      ...over,
    };
  }

  it('★引擎**抛异常**时必须报 engine_error（不得伪装成 ok 或 outdated）', async () => {
    // ★catch 分支此前**从未被任何用例执行过**：route 侧唯一的 queueStatus 用例
    //   走的是 engine_outdated（pin 的引擎无该导出），而 engine_error 只以
    //   手写 JSON 出现在组件测试里——那验的是组件消费，不是路由产出。
    //   于是在 catch 里写 `queueStatus:'ok'` 全绿：引擎崩了，界面却说
    //   "没有待复核项"，审计员以为机器都证明完了。
    mockPolicyFindFirst.mockResolvedValue({ id: 'pol1', userId: 'u1', teamId: null,
                                            content: 'Module m.' });
    vi.doMock('@aster-cloud/aster-lang-ts', () => ({
      runSemanticBridge: () => { throw new Error('boom'); },
    }));
    const { GET } = await import('@/app/api/policies/[id]/review/route');

    const body = await (await GET(
      new Request('http://cloud.test/api/policies/pol1/review'), PARAMS)).json() as
      { queueStatus: string; items: unknown[];
        counts: { verified: number; reviewRequired: number; rejected: number } };

    // 三态必须**互相可区分**：故障 ≠ 版本过旧 ≠ 正常。
    expect(body.queueStatus).toBe('engine_error');
    expect(body.items).toEqual([]);
    expect(body.counts).toEqual({ verified: 0, reviewRequired: 0, rejected: 0 });
  });

  it('★只有 REVIEW_REQUIRED 进队列 —— 机器已证明的不得回流给人', async () => {
    mockPolicyFindFirst.mockResolvedValue({ id: 'pol1', userId: 'u1', teamId: null,
                                            content: 'Module m.' });
    // ★必须有**两条** REVIEW_REQUIRED 且五字段全异。只留一条时，
    //   `arr[0] === v` 恒成立，"逐条映射"与"全取第一条"不可区分——
    //   于是 text/span/reason/contentHash 全部串线也照样绿。
    stubEngine([
      cand({ mapping: { text: 'ok', nodeId: '$.v', span: { start: 0, end: 2 } },
             result: { verdict: 'VERIFIED', reason: '' } }),
      cand(),
      cand({ mapping: { text: '30 days', nodeId: '$.b', span: { start: 80, end: 87 } },
             result: { verdict: 'REVIEW_REQUIRED', reason: '第二条机器理由' },
             contentHash: 'b'.repeat(64) }),
      cand({ mapping: { text: 'no', nodeId: '$.r', span: { start: 0, end: 2 } },
             result: { verdict: 'REJECTED', reason: '' } }),
    ]);
    const { GET } = await import('@/app/api/policies/[id]/review/route');

    const body = await (await GET(
      new Request('http://cloud.test/api/policies/pol1/review'), PARAMS)).json() as
      { queueStatus: string; items: Record<string, unknown>[];
        counts: { verified: number; reviewRequired: number; rejected: number } };

    expect(body.queueStatus).toBe('ok');
    // ★断言**整条 item**，不只是 nodeId。复核人看到的原文、位置、机器给的理由、
    //   以及他要签字锚定的指纹——全部都可能是假的，而他签下去的 Proof
    //   会把这些假值写进不可变审计表。
    // 两条都整体断言：串线任意一个字段都会变红。
    expect(body.items).toEqual([
      { text: '10000', nodeId: '$.a', span: { start: 37, end: 42 },
        reason: '机器证不了', contentHash: 'a'.repeat(64) },
      { text: '30 days', nodeId: '$.b', span: { start: 80, end: 87 },
        reason: '第二条机器理由', contentHash: 'b'.repeat(64) },
    ]);
    // counts 也必须来自引擎，写死 {0,0,0} 等于抹掉机器的全部工作量。
    expect(body.counts).toEqual({ verified: 5, reviewRequired: 2, rejected: 9 });
  });

  it('★contentHash 长度合格但**非十六进制**的候选不得进队列', async () => {
    // `'z'.repeat(64)` 长度正好 64，只查长度会放行；它随后必被写入侧的
    // /^[0-9a-f]{64}$/ 以 400 拒绝——用户点下去才发现签不了。
    // 队列侧与写入侧必须共用同一条规则。
    mockPolicyFindFirst.mockResolvedValue({ id: 'pol1', userId: 'u1', teamId: null,
                                            content: 'Module m.' });
    stubEngine([
      cand({ contentHash: 'z'.repeat(64) }),
      cand({ mapping: { text: 'y', nodeId: '$.good', span: { start: 0, end: 1 } },
             contentHash: 'b'.repeat(64) }),
    ]);
    const { GET } = await import('@/app/api/policies/[id]/review/route');

    const body = await (await GET(
      new Request('http://cloud.test/api/policies/pol1/review'), PARAMS)).json() as
      { items: { nodeId: string }[] };

    expect(body.items.map((i) => i.nodeId)).toEqual(['$.good']);
  });

  it('★contentHash 不是 64 位十六进制的候选不得进队列', async () => {
    // 进了也签不下去：POST 用 /^[0-9a-f]{64}$/ 校验，用户点了才被 400 拒。
    mockPolicyFindFirst.mockResolvedValue({ id: 'pol1', userId: 'u1', teamId: null,
                                            content: 'Module m.' });
    stubEngine([
      cand({ contentHash: undefined }),
      cand({ mapping: { text: 'x', nodeId: '$.short', span: { start: 0, end: 1 } },
             contentHash: 'abc' }),
      cand({ mapping: { text: 'y', nodeId: '$.good', span: { start: 0, end: 1 } },
             contentHash: 'b'.repeat(64) }),
    ]);
    const { GET } = await import('@/app/api/policies/[id]/review/route');

    const body = await (await GET(
      new Request('http://cloud.test/api/policies/pol1/review'), PARAMS)).json() as
      { items: { nodeId: string }[] };

    expect(body.items.map((i) => i.nodeId)).toEqual(['$.good']);
  });
});
