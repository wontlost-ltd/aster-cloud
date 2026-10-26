// 词汇失效感知改为轮询版本号（#608）：跨 isolate 一致，首个版本只作基线。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  POLL_INTERVAL_MS,
  useDomainVocabularyInvalidate,
} from '@/hooks/useDomainVocabularyInvalidate';

function versionResponse(version: string, status = 200) {
  return new Response(JSON.stringify({ version }), { status });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(global.fetch).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useDomainVocabularyInvalidate', () => {
  it('首个版本只作基线；版本变化时 tick 递增，不变则不动', async () => {
    const versions = ['1-100', '1-100', '2-200'];
    vi.mocked(global.fetch).mockImplementation(async () => versionResponse(versions.shift() ?? '2-200'));

    const { result } = renderHook(() =>
      useDomainVocabularyInvalidate({ match: { domain: 'finance', locale: 'de' } }),
    );
    await flush();
    expect(result.current).toBe(0);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/v1/domain-vocabularies/version?domain=finance&locale=de',
      expect.objectContaining({ cache: 'no-store' }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(result.current).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(result.current).toBe(1);
  });

  it('401 时停止轮询', async () => {
    vi.mocked(global.fetch).mockImplementation(async () => new Response('{}', { status: 401 }));
    renderHook(() => useDomainVocabularyInvalidate());
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('enabled=false 不发请求', async () => {
    renderHook(() => useDomainVocabularyInvalidate({ enabled: false }));
    await flush();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
