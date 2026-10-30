// dashboard 执行路由（/api/policies/[id]/execute）执行失败脱敏测试（#609）。
//
// 引擎失败原文（中文 + Java 异常）只写服务端日志；响应与 Execution 行只含通用说明 + 稳定错误码。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockValuesInsert, mockInsert, mockDbExecute, mockGetSession, mockExecute } = vi.hoisted(() => {
  const mockOnConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const mockValuesInsert = vi.fn().mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
  return {
    mockValuesInsert,
    mockInsert: vi.fn().mockReturnValue({ values: mockValuesInsert }),
    mockDbExecute: vi.fn(),
    mockGetSession: vi.fn(),
    mockExecute: vi.fn(),
  };
});

vi.mock('@/lib/auth', () => ({ getSession: () => mockGetSession() }));

vi.mock('@/lib/cache', () => ({
  getCachedPolicyMeta: vi.fn().mockResolvedValue(null),
  cachePolicyMeta: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/team-permissions', () => ({
  checkTeamPermission: vi.fn().mockResolvedValue({ allowed: true }),
  TeamPermission: { POLICY_EXECUTE: 'policy.execute' },
}));

vi.mock('@/services/policy/runner-parity-from-execution', () => ({
  maybeRunParityForExecution: vi.fn().mockResolvedValue(null),
  RUNNER_LAUNCHER_HMAC_ROLE: 'runner-launcher',
}));

vi.mock('@/services/policy/cnl-executor', () => ({
  executePolicyUnified: (o: unknown) => mockExecute(o),
  getPrimaryError: vi.fn((r: { deniedReasons: string[] }) => r.deniedReasons[0]),
  detectCNLLocale: vi.fn(() => 'en-US'),
  deriveExecutionDecision: vi.fn((r: { metadata?: { engineError?: boolean }; inputError?: unknown }) =>
    r?.metadata?.engineError || r?.inputError ? 'error' : 'denied'),
  deriveExecutionOutcome: vi.fn((r: { metadata?: { outcome?: string } }) => r?.metadata?.outcome ?? 'ALLOW'),
}));

// guard 登记（ADR 0042 §5.1）不在本文件断言范围：装配客户端与通知均替身，开决策走成功路径。
vi.mock('@/lib/policy-api-identity', () => ({
  createPolicyApiClientForUser: vi.fn().mockResolvedValue({
    guardFromEvidence: vi.fn().mockResolvedValue({ decisionId: 'd1', approval: { id: 'a1', status: 'PENDING' } }),
  }),
}));
vi.mock('@/lib/guard-notifications', () => ({ notifyApprovalRequested: vi.fn().mockResolvedValue(undefined) }));

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: vi.fn().mockRejectedValue(new Error('Not cloudflare')),
}));

vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      users: { findFirst: vi.fn() },
      policies: { findMany: vi.fn().mockResolvedValue([{ id: 'p1' }]) },
      policyVersions: { findMany: vi.fn().mockResolvedValue([]) },
    },
    insert: mockInsert,
    execute: mockDbExecute,
  },
  policies: { id: {}, userId: {}, updatedAt: {} },
  policyVersions: { policyId: {} },
  executions: { id: {} },
  users: { id: {} },
  usageRecords: { userId: {}, type: {}, period: {}, count: {} },
}));

import { POST } from '@/app/api/policies/[id]/execute/route';
import { executions } from '@/lib/prisma';

function execResult(metadata: Record<string, unknown>) {
  return {
    allowed: false,
    approved: false,
    matchedRules: [],
    deniedReasons: [],
    metadata: {
      evaluatedAt: '2026-10-08T00:00:00Z', policyId: 'p1', policyName: 'P',
      ruleCount: 1, matchedRuleCount: 0, denyCount: 0, engine: 'aster-cnl', ...metadata,
    },
  };
}

function request(body: unknown): Request {
  return new Request('http://localhost/api/policies/p1/execute', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const params = { params: Promise.resolve({ id: 'p1' }) };

const RAW =
  'CNL 动态执行失败: Polyglot 执行失败: java.lang.RuntimeException: 无法访问成员：alter。该对象的可用成员为 [age]';

describe('POST /api/policies/[id]/execute — 执行失败脱敏（#609）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsert.mockReturnValue({ values: mockValuesInsert });
    mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });
    mockDbExecute.mockResolvedValue([{
      policy_id: 'p1', policy_name: 'P', policy_content: 'Module X. Rule r given x: Return true.',
      policy_alias_set: null, policy_user_id: 'user-1', policy_team_id: null, policy_is_public: false,
      policy_version_row_id: 'pv-1', policy_version: 1, policy_source_toolchain_id: null, policy_vocab_snapshot_ids: null,
      user_plan: 'pro', user_trial_ends_at: null, usage_count: 0, is_team_member: false,
    }]);
  });

  it('引擎失败：响应与落库只含通用说明 + execution_failed，原文进日志', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockExecute.mockResolvedValue({
      ...execResult({ engineError: true, denyCount: 1 }),
      deniedReasons: [RAW],
      diagnostics: [
        { code: 'RUNTIME', message: 'java.lang.IllegalStateException: boom\n\tat io.aster.X.run(X.java:12)' },
      ],
    });

    const res = await POST(request({ input: { fahrer: { age: 21 } } }), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.errorCode).toBe('execution_failed');
    expect(body.error).not.toContain('java.lang');
    expect(body.diagnostics).toEqual([{ code: 'RUNTIME', message: body.error }]);
    expect(JSON.stringify(body)).not.toMatch(/java\.lang|Polyglot|无法访问/);
    expect(mockInsert).toHaveBeenCalledWith(executions);
    const persisted = mockValuesInsert.mock.calls.find(
      ([row]) => (row as { source?: string }).source === 'dashboard',
    )?.[0] as { error?: string; output?: unknown };
    expect(persisted.error).toBe(body.error);
    expect(JSON.stringify(persisted.output)).not.toMatch(/java\.lang|Polyglot/);
    expect(log).toHaveBeenCalledWith(
      '[policy-execute] engine error',
      expect.objectContaining({ policyId: 'p1', reasons: [RAW] }),
    );
    log.mockRestore();
  });

  it('诊断中的相对路径、jar、Windows 路径被替换；提到裸异常类名的 CNL 诊断原样返回', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockExecute.mockResolvedValue({
      ...execResult({ denyCount: 1 }),
      deniedReasons: ['Applicant is under 18'],
      diagnostics: [
        { code: 'D1', message: 'failed in src/main/java/io/aster/Foo.java:42' },
        { code: 'D2', message: 'cannot load aster-core-1.0.35.jar' },
        { code: 'D3', message: 'cannot open C:\\aster\\lib\\core.dll' },
        { code: 'D4', message: 'Rule validate raises ValidationException when age is missing' },
      ],
    });

    const res = await POST(request({ input: { age: 10 } }), params);
    const body = await res.json();

    expect(body.diagnostics).toEqual([
      { code: 'D1', message: expect.not.stringMatching(/Foo\.java/) },
      { code: 'D2', message: expect.not.stringMatching(/\.jar/) },
      { code: 'D3', message: expect.not.stringMatching(/C:/) },
      { code: 'D4', message: 'Rule validate raises ValidationException when age is missing' },
    ]);
    expect(body.error).toBe('Applicant is under 18');
    const persisted = mockValuesInsert.mock.calls.find(
      ([row]) => (row as { source?: string }).source === 'dashboard',
    )?.[0] as { output?: unknown };
    expect(JSON.stringify(persisted.output)).not.toMatch(/Foo\.java|\.jar|C:\\\\/);
    log.mockRestore();
  });

  it('正常拒绝：拒绝理由原样返回，无 errorCode', async () => {
    mockExecute.mockResolvedValue({ ...execResult({ denyCount: 1 }), deniedReasons: ['Applicant is under 18'] });

    const res = await POST(request({ input: { age: 10 } }), params);
    const body = await res.json();

    expect(body.error).toBe('Applicant is under 18');
    expect(body.errorCode).toBeUndefined();
  });

  it('输入缺少规则读取的字段：照常写执行记录（decision=error）与用量，再回 400 + missing_input_field', async () => {
    mockExecute.mockResolvedValue({
      ...execResult({ denyCount: 1 }),
      deniedReasons: ['The input is missing the field "applicant.creditScore" that the policy reads.'],
      inputError: { code: 'missing_input_field', field: 'applicant.creditScore' },
    });

    const res = await POST(request({ input: { applicant: { id: 'A1', age: 35 } } }), params);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe('missing_input_field');
    expect(body.field).toBe('applicant.creditScore');
    // 无词汇：策略语言写法与规范名相同
    expect(body.policyField).toBe('applicant.creditScore');
    expect(body.error).toContain('applicant.creditScore');
    expect(body.executionId).toEqual(expect.any(String));
    expect(JSON.stringify(body)).not.toMatch(/java\.lang|Polyglot|execution_failed/);
    expect(mockInsert).toHaveBeenCalledWith(executions);
    const persisted = mockValuesInsert.mock.calls.find(
      ([row]) => (row as { source?: string }).source === 'dashboard',
    )?.[0] as { id?: string; decision?: string; error?: string; output?: { inputError?: unknown } };
    expect(persisted.id).toBe(body.executionId);
    expect(persisted.decision).toBe('error');
    expect(persisted.error).toContain('applicant.creditScore');
    expect(persisted.output?.inputError).toEqual({ code: 'missing_input_field', field: 'applicant.creditScore' });
    // 用量照常计数（usageRecords upsert）
    expect(mockValuesInsert.mock.calls.some(([row]) => (row as { type?: string }).type === 'execution')).toBe(true);
  });

  it('路由内部异常：500 只回稳定码与通用说明', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockExecute.mockRejectedValue(new Error('java.lang.IllegalStateException: boom'));

    const res = await POST(request({ input: { a: 1 } }), params);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.code).toBe('execution_failed');
    expect(body.message).not.toContain('java.lang');
    expect(body).not.toHaveProperty('debug');
    expect(JSON.stringify(body)).not.toContain('IllegalStateException');
    log.mockRestore();
  });
});
