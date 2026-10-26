import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPolicyApiClient } from '@/services/policy/policy-api';

// 只验证 compile 请求体：结构词授权仅在「有别名且已授权」时携带（#604）。
describe('PolicyApiClient.compile — allowStructural 请求体', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true, diagnostics: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sentBody(): Record<string, unknown> {
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    return JSON.parse(String(init.body)) as Record<string, unknown>;
  }

  it('有别名且已授权 → 携带 allowStructural: true', async () => {
    await createPolicyApiClient('u1', 'u1').compile({
      source: 'Module X.',
      locale: 'en-US',
      aliasSet: { IF: ['provided that'] },
      allowStructural: true,
    });
    expect(sentBody()).toEqual({
      source: 'Module X.',
      locale: 'en-US',
      aliasSet: { IF: ['provided that'] },
      allowStructural: true,
    });
  });

  it('未授权 → 不携带 allowStructural', async () => {
    await createPolicyApiClient('u1', 'u1').compile({
      source: 'Module X.',
      aliasSet: { TIMES: ['multiplied by'] },
      allowStructural: false,
    });
    expect(sentBody()).not.toHaveProperty('allowStructural');
  });

  it('无别名时即使已授权也不携带', async () => {
    await createPolicyApiClient('u1', 'u1').compile({ source: 'Module X.', allowStructural: true });
    expect(sentBody()).toEqual({ source: 'Module X.', locale: 'en-US' });
  });
});
