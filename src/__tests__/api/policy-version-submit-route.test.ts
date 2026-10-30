import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * POST /api/v1/policies/{id}/versions/{version}/submit：
 *   - 成功后通知团队里能审批的人（#678）
 *   - 版本不存在 / 状态不可提交 → 400 version_not_submittable，英文提示（#680：此前是硬编码中文）
 */
const h = vi.hoisted(() => ({ submit: vi.fn(), notify: vi.fn() }));

vi.mock('@/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1' } })) }));
vi.mock('@/lib/version-notifications', () => ({ notifyVersionSubmitted: h.notify }));
vi.mock('@/lib/after-response', () => ({ runAfterResponse: (task: () => unknown) => void task() }));
vi.mock('@/services/policy/version-manager', async () => {
  class PolicyAccessDeniedError extends Error {}
  return { submitForApproval: h.submit, PolicyAccessDeniedError };
});

import { POST } from '@/app/api/v1/policies/[id]/versions/[version]/submit/route';
import { VersionStateError } from '@/services/policy/version-state-error';

const call = (version = '2') =>
  POST(
    new Request('http://x', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }) as never,
    { params: Promise.resolve({ id: 'p1', version }) },
  );

describe('submit route', () => {
  beforeEach(() => vi.clearAllMocks());

  it('成功 → 200，并通知审批人', async () => {
    h.submit.mockResolvedValue(undefined);
    const res = await call();
    expect(res.status).toBe(200);
    expect(h.notify).toHaveBeenCalledWith({ policyId: 'p1', version: 2, submitterId: 'u1' });
  });

  it('版本不可提交 → 400 version_not_submittable，英文提示，不通知', async () => {
    h.submit.mockRejectedValue(
      new VersionStateError('version_not_submittable', 'Version v1 does not exist or cannot be submitted for approval in its current status.'),
    );
    const res = await call('1');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('version_not_submittable');
    expect(body.error).not.toMatch(/[一-鿿]/);
    expect(h.notify).not.toHaveBeenCalled();
  });
});
