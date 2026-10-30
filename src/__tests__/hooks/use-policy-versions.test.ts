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

  it('★设为默认失败：返回服务端 message（不是错误码），列表与 error 不变', async () => {
    const { result } = await mountLoaded();
    fetchMock.mockResolvedValueOnce(json({ error: 'forbidden', message: 'Only admins can set default' }, 403));
    let outcome: Awaited<ReturnType<typeof result.current.setDefault>> | undefined;
    await act(async () => { outcome = await result.current.setDefault(2); });
    expect(outcome).toEqual({ ok: false, message: 'Only admins can set default' });
    expect(result.current.error).toBeNull();
    expect(result.current.versions).toHaveLength(2);
  });

  it('★提交失败：响应带 message 时用 message，而不是 error 里的错误码', async () => {
    const { result } = await mountLoaded();
    fetchMock.mockResolvedValueOnce(json({ error: 'simulated_failure', message: 'Service unavailable' }, 503));
    let submitted: Awaited<ReturnType<typeof result.current.submitForApproval>> | undefined;
    await act(async () => { submitted = await result.current.submitForApproval(2); });
    expect(submitted).toEqual({ ok: false, message: 'Service unavailable' });
  });

  it('只有 error 时回退到 error', async () => {
    const { result } = await mountLoaded();
    fetchMock.mockResolvedValueOnce(json({ error: 'Version already pending' }, 409));
    let submitted: Awaited<ReturnType<typeof result.current.submitForApproval>> | undefined;
    await act(async () => { submitted = await result.current.submitForApproval(2); });
    expect(submitted).toEqual({ ok: false, message: 'Version already pending' });
    expect(result.current.actionError).toBeNull();
  });

  it('批准失败的 message 同样优先取服务端 message', async () => {
    const { result } = await mountLoaded();
    fetchMock.mockResolvedValueOnce(json({ error: 'conflict', message: 'Approval conflict' }, 409));
    let approved: Awaited<ReturnType<typeof result.current.approve>> | undefined;
    await act(async () => { approved = await result.current.approve(2); });
    expect(approved).toMatchObject({ ok: false, errorCode: 'other', message: 'Approval conflict' });
  });

  it('列表加载失败仍写 error', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'load failed' }, 500));
    const { result } = renderHook(() => usePolicyVersions({ policyId: 'pol-1' }));
    await waitFor(() => expect(result.current.error).toBe('load failed'));
  });
});
