/**
 * usePolicyVersions：操作失败不得冒充「列表加载失败」。
 *
 * 2026-10-30 生产复测 F2：批准被 409 vocabulary_changed_since_save 拒绝后，hook 把服务端消息写进
 * 列表级 error，版本标签页随即用「错误 + Try again」整块替换版本列表，要刷新页面才恢复。
 * error 只表示列表没加载出来；操作失败另走 actionError（批准失败由调用方 toast，不再重复）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { usePolicyVersions } from '@/hooks/use-policy-versions';

const VERSIONS = [
  { id: 'v1', version: 1, status: 'APPROVED', isDefault: true },
  { id: 'v2', version: 2, status: 'PENDING_APPROVAL', isDefault: false },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

async function mountLoaded() {
  fetchMock.mockResolvedValueOnce(json({ versions: VERSIONS }));
  const hook = renderHook(() => usePolicyVersions({ policyId: 'pol-1' }));
  await waitFor(() => expect(hook.result.current.versions).toHaveLength(2));
  return hook;
}

describe('usePolicyVersions 操作失败', () => {
  it('★批准 409 vocabulary_changed_since_save：返回错误码，列表与 error 不变', async () => {
    const { result } = await mountLoaded();
    fetchMock.mockResolvedValueOnce(json({ error: 'vocabulary_changed_since_save', message: 'changed' }, 409));
    let outcome: Awaited<ReturnType<typeof result.current.approve>> | undefined;
    await act(async () => { outcome = await result.current.approve(2); });
    expect(outcome).toMatchObject({ ok: false, errorCode: 'vocabulary_changed_since_save' });
    expect(result.current.error).toBeNull();
    expect(result.current.actionError).toBeNull();
    expect(result.current.versions).toHaveLength(2);
  });

  it('设为默认失败：写 actionError，不写列表级 error', async () => {
    const { result } = await mountLoaded();
    fetchMock.mockResolvedValueOnce(json({ error: 'nope' }, 403));
    await act(async () => { await result.current.setDefault(2); });
    expect(result.current.error).toBeNull();
    expect(result.current.actionError).toBe('nope');
    expect(result.current.versions).toHaveLength(2);
    act(() => result.current.clearActionError());
    expect(result.current.actionError).toBeNull();
  });

  it('失败横幅在下一次操作成功后自动清除', async () => {
    const { result } = await mountLoaded();
    fetchMock.mockResolvedValueOnce(json({ error: 'nope' }, 403));
    await act(async () => { await result.current.setDefault(2); });
    expect(result.current.actionError).toBe('nope');
    fetchMock
      .mockResolvedValueOnce(json({ ok: true }))
      .mockResolvedValueOnce(json({ versions: VERSIONS }));
    await act(async () => { await result.current.submitForApproval(2); });
    expect(result.current.actionError).toBeNull();
  });

  it('批准开始时同样清除上一次的失败横幅', async () => {
    const { result } = await mountLoaded();
    fetchMock.mockResolvedValueOnce(json({ error: 'nope' }, 403));
    await act(async () => { await result.current.setDefault(2); });
    fetchMock.mockResolvedValueOnce(json({ error: 'segregation_of_duties' }, 403));
    await act(async () => { await result.current.approve(2); });
    expect(result.current.actionError).toBeNull();
  });

  it('列表加载失败仍写 error', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'load failed' }, 500));
    const { result } = renderHook(() => usePolicyVersions({ policyId: 'pol-1' }));
    await waitFor(() => expect(result.current.error).toBe('load failed'));
  });
});
