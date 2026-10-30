import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 策略版本源码拉取端点（What-If 重放用）。
 *
 * ★这是个**内部端点**，返回的是**用户策略源码**——用户资产。
 * 故重点不是「查得对不对」，而是三道边界：
 *   1. 无共享密钥 → 503（fail-closed，不是放行）
 *   2. 验签失败 → 401
 *   3. 查询**必须**按 userId 过滤——租户隔离不是可选项
 *
 * 背景：aster-api 原本在自己库里找目标版本，但那张表是执行期编译缓存
 * （id 为 bigint 自增），与本库的 PolicyVersion（UUID）不是同一批数据，
 * 导致 UI 发起的 What-If **从未成功过**。改由本端点提供源码。
 */

const verifyInternalSignature = vi.hoisted(() => vi.fn());
vi.mock('@/lib/internal-signature', () => ({ verifyInternalSignature }));

const captured = vi.hoisted(() => ({ where: undefined as unknown }));
const rows = vi.hoisted(() => ({ value: [] as unknown[] }));

vi.mock('@/lib/prisma', () => {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: (w: unknown) => {
      captured.where = w;
      return chain;
    },
    // 未显式给出时默认是调用者（u1）本人的个人策略
    limit: () => Promise.resolve(
      (rows.value as Record<string, unknown>[]).map((r) => ({ policyUserId: 'u1', policyTeamId: null, ...r })),
    ),
  };
  return {
    db: { select: () => chain },
    policyVersions: new Proxy({}, { get: (_t, p) => `policyVersions.${String(p)}` }),
    policies: new Proxy({}, { get: (_t, p) => `policies.${String(p)}` }),
  };
});

const loadStoredVersionCompileContext = vi.hoisted(() =>
  vi.fn(async () => ({ locale: 'en-US', vocabulary: undefined as Record<string, unknown> | undefined })),
);
vi.mock('@/lib/execution-input', () => ({ loadStoredVersionCompileContext }));

// 团队策略按授权矩阵复核创建者的当前角色（真实判定，只替换角色读取）
vi.mock('@/lib/policy-access', async () =>
  (await import('@/__tests__/helpers/policy-access-mock')).policyAccessModule());

vi.mock('drizzle-orm', () => ({
  and: (...xs: unknown[]) => ({ op: 'and', xs: xs.filter(Boolean) }),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
}));

const { GET } = await import('@/app/api/internal/policy-versions/route');
const { policyAccessState } = await import('@/__tests__/helpers/policy-access-mock');

const URL_OK =
  'https://x.test/api/internal/policy-versions?versionId=v-uuid&userId=u1';

function req(url = URL_OK) {
  return new Request(url);
}

describe('内部端点：策略版本源码', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.where = undefined;
    rows.value = [];
    process.env.ASTER_PLAN_GATE_HMAC_KEY = 'k';
    verifyInternalSignature.mockResolvedValue({ ok: true });
  });

  it('★没有共享密钥 → 503，绝不放行', async () => {
    delete process.env.ASTER_PLAN_GATE_HMAC_KEY;
    const res = await GET(req());
    expect(res.status).toBe(503);
  });

  it('★验签失败 → 401', async () => {
    verifyInternalSignature.mockResolvedValue({ ok: false, reason: 'bad_sig' });
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it('★缺 userId → 400（不能"忘了传就拿到全量"）', async () => {
    const res = await GET(
      req('https://x.test/api/internal/policy-versions?versionId=v-uuid'),
    );
    expect(res.status).toBe(400);
  });

  it('缺 versionId → 400', async () => {
    const res = await GET(
      req('https://x.test/api/internal/policy-versions?userId=u1'),
    );
    expect(res.status).toBe(400);
  });

  it('★查询条件必须同时含 versionId 与 userId（租户隔离）', async () => {
    rows.value = [{ id: 'v-uuid', policyId: 'p1', version: 2, content: 'Module x.' }];
    await GET(req());

    const json = JSON.stringify(captured.where);
    expect(json, '查询未按 versionId 过滤').toContain('policyVersions.id');
    expect(json, '查询未按 userId 过滤 → 可跨租户读取他人源码').toContain(
      'policies.userId',
    );
    expect(json).toContain('u1');
  });

  it('命中时返回源码（无词汇、无别名时不带这两个字段）', async () => {
    rows.value = [{ id: 'v-uuid', policyId: 'p1', version: 2, content: 'Module x.' }];
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      versionId: 'v-uuid',
      policyId: 'p1',
      version: 2,
      content: 'Module x.',
    });
  });

  it('附带版本的领域词汇与冻结别名（ADR 0051：重放与执行同一份编译输入）', async () => {
    const vocabulary = { id: 'grades', locale: 'de-DE', structs: [], fields: [], functions: [] };
    loadStoredVersionCompileContext.mockResolvedValueOnce({ locale: 'de-DE', vocabulary });
    const row = {
      id: 'v-uuid', policyId: 'p1', version: 3, content: 'Modul x.', status: 'APPROVED', createdBy: 'author-1',
      vocabularySnapshotIds: [{ snapshotId: 's1', domain: 'grades', locale: 'de' }],
      aliasSet: '{"return":["Gib zurück"]}', sourceEnvelopeSha256: null, sourceScopesJson: null, sourceToolchainId: null,
    };
    rows.value = [row];

    const res = await GET(req());

    expect(await res.json()).toEqual({
      versionId: 'v-uuid', policyId: 'p1', version: 3, content: 'Modul x.',
      vocabulary, aliasSet: { return: ['Gib zurück'] },
    });
    // 已审批 / 已弃用取冻结快照、草稿取作者现行词汇由 helper 按 status 判定，这里传齐判定所需字段
    expect(loadStoredVersionCompileContext).toHaveBeenCalledWith(expect.objectContaining({
      source: 'Modul x.', status: 'APPROVED', createdBy: 'author-1',
      vocabularySnapshotIds: row.vocabularySnapshotIds, aliasSet: row.aliasSet,
    }));
  });

  // #650：重放必须与执行同一份词汇；词汇加载失败不能退化为无词汇（重放结果会被静默算错）
  it('版本词汇加载失败 → 503 vocabulary_unavailable + Retry-After，不返回源码', async () => {
    rows.value = [{ id: 'v-uuid', policyId: 'p1', version: 2, content: 'Module x.', status: 'APPROVED' }];
    loadStoredVersionCompileContext.mockRejectedValueOnce(
      Object.assign(new Error('Domain vocabulary could not be loaded.'), { name: 'VersionVocabularyUnavailableError', code: 'vocabulary_unavailable' }),
    );
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    const body = await res.json();
    expect(body).toMatchObject({ error: 'vocabulary_unavailable', code: 'vocabulary_unavailable' });
    expect(body).not.toHaveProperty('content');
  });

  it('作者词汇非法 → 400 vocabulary_scope_invalid', async () => {
    rows.value = [{ id: 'v-uuid', policyId: 'p1', version: 2, content: 'Module x.', status: 'DRAFT' }];
    loadStoredVersionCompileContext.mockRejectedValueOnce(
      Object.assign(new Error('field_parent_required: 字段 "alter" 缺少 parent'), { name: 'VocabularyScopeError', code: 'field_parent_required' }),
    );
    const res = await GET(req());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'vocabulary_scope_invalid', reason: 'field_parent_required', term: 'alter' });
  });

  it('★查不到 → 404，且不区分"不存在"与"不属于你"', async () => {
    rows.value = [];
    const res = await GET(req());
    expect(res.status).toBe(404);
    // 错误体不得泄露该 id 是否存在——否则成了可探测的存在性信号。
    expect(await res.json()).toEqual({ error: 'version_not_found' });
  });

  it('团队策略：创建者仍有执行权限 → 200；离队（无成员行）或降为 viewer → 404（ADR 0016 §2）', async () => {
    rows.value = [{ id: 'v-uuid', policyId: 'p1', version: 2, content: 'Module x.', policyTeamId: 't1' }];
    policyAccessState.teamRole = 'member';
    expect((await GET(req())).status).toBe(200);
    policyAccessState.teamRole = 'viewer';
    expect((await GET(req())).status).toBe(404);
    policyAccessState.teamRole = null;
    expect((await GET(req())).status).toBe(404);
  });
});
