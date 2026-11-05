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

  // #697：版本状态错误码随结果返回，由界面按 code 本地化
  it.each([
    ['setDefault', 'version_not_approved'],
    ['deprecate', 'default_version_locked'],
    ['archive', 'version_not_archivable'],
  ] as const)('%s 失败带版本状态错误码 %s：结果带 code 与服务端 message', async (fn, code) => {
    const { result } = await mountLoaded();
    fetchMock.mockResolvedValueOnce(json({ error: 'Version v2 …', code, message: 'Version v2 …' }, 400));
    let outcome: Awaited<ReturnType<typeof result.current.setDefault>> | undefined;
    await act(async () => { outcome = await result.current[fn](2); });
    expect(outcome).toEqual({ ok: false, code, message: 'Version v2 …' });
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

  // #662：兜底 500 是结构化 envelope（error 为对象），返回的 message 必须是字符串
  it('归档失败返回 500 envelope：message 取 error.message 字符串', async () => {
    const { result } = await mountLoaded();
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'internal_error', message: 'Could not archive version.', requestId: 'r1' } }, 500));
    let archived: Awaited<ReturnType<typeof result.current.archive>> | undefined;
    await act(async () => { archived = await result.current.archive(2); });
    expect(archived).toEqual({ ok: false, message: 'Could not archive version.' });
  });

  it('批准失败返回 envelope 形式的 segregation_of_duties：错误码仍被识别', async () => {
    const { result } = await mountLoaded();
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'segregation_of_duties', message: 'x', requestId: 'r1' } }, 403));
    let approved: Awaited<ReturnType<typeof result.current.approve>> | undefined;
    await act(async () => { approved = await result.current.approve(2); });
    expect(approved).toMatchObject({ ok: false, errorCode: 'segregation_of_duties', message: 'x' });
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

// #711：hook 不再带中文兜底文案。服务端没给 message 时，操作结果的 message 为空、由界面按场景本地化；
// 列表 / 创建失败写稳定 code，界面按 code 本地化；网络异常原文不进界面。
describe('usePolicyVersions 兜底文案（#711）', () => {
  it.each(['setDefault', 'deprecate', 'archive', 'submitForApproval'] as const)('%s 失败且无 message：message 为空', async (op) => {
    const { result } = await mountLoaded();
    fetchMock.mockResolvedValueOnce(json({}, 500));
    let outcome: { ok: boolean; message?: string } | undefined;
    await act(async () => { outcome = await (result.current[op] as (v: number) => Promise<{ ok: boolean; message?: string }>)(2); });
    expect(outcome).toEqual({ ok: false });
  });

  it('网络异常：不回传异常原文', async () => {
    const { result } = await mountLoaded();
    fetchMock.mockRejectedValueOnce(new TypeError('connect ECONNREFUSED 10.0.0.5:8080'));
    let outcome: { ok: boolean; message?: string } | undefined;
    await act(async () => { outcome = await result.current.reject(2, 'why'); });
    expect(outcome).toEqual({ ok: false });
    fetchMock.mockRejectedValueOnce(new TypeError('connect ECONNREFUSED 10.0.0.5:8080'));
    let approved: Awaited<ReturnType<typeof result.current.approve>> | undefined;
    await act(async () => { approved = await result.current.approve(2); });
    expect(approved).toEqual({ ok: false, errorCode: 'other' });
  });

  it('列表加载失败且无 message：error 为稳定 code', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 500));
    const { result } = renderHook(() => usePolicyVersions({ policyId: 'pol-1' }));
    await waitFor(() => expect(result.current.error).toBe('versions_load_failed'));
  });

  it('列表加载网络异常：error 为稳定 code', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const { result } = renderHook(() => usePolicyVersions({ policyId: 'pol-1' }));
    await waitFor(() => expect(result.current.error).toBe('versions_load_failed'));
  });

  it('创建失败且无 message：actionError 为稳定 code', async () => {
    const { result } = await mountLoaded();
    fetchMock.mockResolvedValueOnce(json({}, 500));
    await act(async () => { await result.current.createVersion('src'); });
    expect(result.current.actionError).toBe('version_create_failed');
  });

  it('hook 源码不含中文字符串字面量', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const src = readFileSync(path.resolve(__dirname, '../../hooks/use-policy-versions.ts'), 'utf8');
    const literals = src.match(/(['"`])(?:(?!\1)[^\\\n]|\\.)*\1/g) ?? [];
    expect(literals.filter((l) => /[一-鿿]/.test(l))).toEqual([]);
  });
});
