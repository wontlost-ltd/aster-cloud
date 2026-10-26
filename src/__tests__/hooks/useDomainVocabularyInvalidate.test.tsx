// 词汇失效感知改为轮询版本号（#608）：跨 isolate 一致，首个版本只作基线，全页共享一个轮询器。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
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
  cleanup(); // 卸载即退订，模块级轮询器随之拆除，用例之间不串
  vi.useRealTimers();
});

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useDomainVocabularyInvalidate', () => {
  it('首个版本只作基线；版本变化时 tick 递增，不变则不动', async () => {
    const versions = ['1', '1', '2'];
    vi.mocked(global.fetch).mockImplementation(async () => versionResponse(versions.shift() ?? '2'));

    const { result } = renderHook(() =>
      useDomainVocabularyInvalidate({ match: { domain: 'finance', locale: 'de' } }),
    );
    await flush();
    expect(result.current).toBe(0);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/v1/domain-vocabularies/version',
      expect.objectContaining({ cache: 'no-store' }),
    );

    await advance(POLL_INTERVAL_MS);
    expect(result.current).toBe(0);

    await advance(POLL_INTERVAL_MS);
    expect(result.current).toBe(1);
  });

  it('同页多个 hook 实例共享一个轮询器，版本变化时都收到通知', async () => {
    const versions = ['5', '6'];
    vi.mocked(global.fetch).mockImplementation(async () => versionResponse(versions.shift() ?? '6'));

    const a = renderHook(() => useDomainVocabularyInvalidate({ match: { domain: 'finance' } }));
    const b = renderHook(() => useDomainVocabularyInvalidate({ match: { domain: 'health' } }));
    await flush();
    expect(global.fetch).toHaveBeenCalledTimes(1);

    await advance(POLL_INTERVAL_MS);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(a.result.current).toBe(1);
    expect(b.result.current).toBe(1);

    a.unmount();
    b.unmount();
    await advance(POLL_INTERVAL_MS * 3);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('页面隐藏时暂停，重新可见时立即补拉', async () => {
    vi.mocked(global.fetch).mockImplementation(async () => versionResponse('1'));
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    renderHook(() => useDomainVocabularyInvalidate());
    await flush();
    expect(global.fetch).toHaveBeenCalledTimes(1);

    visibility.mockReturnValue('hidden');
    await advance(POLL_INTERVAL_MS * 3);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    visibility.mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    visibility.mockRestore();
  });

  it('401 时停止轮询', async () => {
    vi.mocked(global.fetch).mockImplementation(async () => new Response('{}', { status: 401 }));
    renderHook(() => useDomainVocabularyInvalidate());
    await flush();
    await advance(POLL_INTERVAL_MS * 5);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('enabled=false 不发请求', async () => {
    renderHook(() => useDomainVocabularyInvalidate({ enabled: false }));
    await flush();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
