// @vitest-environment jsdom
// useSSEStream 的结构化 errorDetail：meta 的 model + error 帧的码 / provider 原话；旧版帧也不崩。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSSEStream } from '@/hooks/useSSEStream';

const WORKSPACE_MSG = 'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace.';

function sse(...frames: unknown[]): Response {
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function run(res: Response) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));
  const { result } = renderHook(() => useSSEStream());
  await act(async () => { await result.current.startStream('/api/llm/generate', {}); });
  return result;
}

afterEach(() => vi.unstubAllGlobals());

describe('useSSEStream.errorDetail', () => {
  it('★新版事故流：meta → upstream_reached → error(provider_bad_request + 原话)', async () => {
    const r = await run(sse(
      { type: 'meta', data: 'claude-sonnet-5-5' },
      { type: 'upstream_reached' },
      { type: 'error', error: 'provider_bad_request', message: WORKSPACE_MSG, providerErrorType: 'invalid_request_error' },
    ));
    expect(r.current.errorDetail).toEqual({ code: 'provider_bad_request', model: 'claude-sonnet-5-5', providerMessage: WORKSPACE_MSG });
    expect(r.current.error).toBe(WORKSPACE_MSG);
  });

  it('★旧版流：error 只有码 → providerMessage=null，model 取自 meta', async () => {
    const r = await run(sse(
      { type: 'meta', data: 'claude-x' },
      { type: 'error', error: 'provider_rejected_model' },
    ));
    expect(r.current.errorDetail).toEqual({ code: 'provider_rejected_model', model: 'claude-x', providerMessage: null });
  });

  it('无 meta → model=null；无错误 → errorDetail=null', async () => {
    const r1 = await run(sse({ type: 'error', error: 'provider_auth_failed' }));
    expect(r1.current.errorDetail).toEqual({ code: 'provider_auth_failed', model: null, providerMessage: null });
    const r2 = await run(sse({ type: 'delta', data: 'hi' }));
    expect(r2.current.errorDetail).toBeNull();
  });
});
