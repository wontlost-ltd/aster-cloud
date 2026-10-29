/**
 * runner parity 两侧都带版本领域词汇（ADR 0051）：名称按位置解析依赖词汇，权威侧与 runner 侧
 * 必须用同一份编译输入，否则会出现假 divergent。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const evaluateSource = vi.hoisted(() => vi.fn());
vi.mock('@/services/policy/policy-api', () => ({
  createPolicyApiClient: () => ({ evaluateSource }),
}));
vi.mock('@/lib/api-signing', () => ({
  signRunnerLauncherHeaders: async () => ({}),
}));

import { callAuthorityForParity } from '@/services/policy/runner-parity';
import { launchRunnerJob } from '@/services/policy/runner-launcher-client';

const vocabulary = { id: 'grades', locale: 'de-DE', structs: [], fields: [], functions: [] };
const base = {
  tenantId: 't1', actorUserId: 'u1', source: 'Modul m.', input: { a: 1 }, locale: 'de-DE',
  functionName: 'f', aliasSet: null, role: 'ADMIN',
};

describe('runner parity 词汇透传', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    evaluateSource.mockReset().mockResolvedValue({ replayMetadata: {} });
    fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({ outcome: 'SUCCESS', replayMetadata: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    process.env.ASTER_RUNNER_LAUNCHER_URL = 'http://launcher.test';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ASTER_RUNNER_LAUNCHER_URL;
  });

  it('权威侧 evaluateSource 带 vocabulary', async () => {
    await callAuthorityForParity({ ...base, vocabulary });
    expect(evaluateSource.mock.calls[0][2]).toMatchObject({ vocabulary, replayCapture: true });
  });

  it('权威侧无词汇时不带 vocabulary 键', async () => {
    await callAuthorityForParity(base);
    expect(evaluateSource.mock.calls[0][2]).not.toHaveProperty('vocabulary');
  });

  it('runner 侧请求体带 vocabulary', async () => {
    const outcome = await launchRunnerJob({ ...base, vocabulary });
    expect(outcome.ok).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).vocabulary).toEqual(vocabulary);
  });
});
