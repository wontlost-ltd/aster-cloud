import { describe, it, expect, vi, beforeEach } from 'vitest';

const { afterImpl } = vi.hoisted(() => ({ afterImpl: { fn: (_t: () => Promise<void>) => {} } }));
vi.mock('next/server', () => ({ after: (t: () => Promise<void>) => afterImpl.fn(t) }));

import { runAfterResponse } from '@/lib/after-response';

describe('runAfterResponse（#714）', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('请求作用域内交给 next/server after，调用方不等待任务', async () => {
    const queued: Array<() => Promise<void>> = [];
    afterImpl.fn = (t) => { queued.push(t); };
    const task = vi.fn().mockResolvedValue(undefined);
    runAfterResponse(task);
    expect(task).not.toHaveBeenCalled();
    await queued[0]();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('任务出错只记日志，不向外抛', async () => {
    const queued: Array<() => Promise<void>> = [];
    afterImpl.fn = (t) => { queued.push(t); };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    runAfterResponse(() => Promise.reject(new Error('smtp down')));
    await expect(queued[0]()).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
  });

  it('请求作用域外 after 抛错时直接后台执行', async () => {
    afterImpl.fn = () => { throw new Error('outside request scope'); };
    let done = false;
    runAfterResponse(async () => { done = true; });
    await new Promise((r) => setTimeout(r, 0));
    expect(done).toBe(true);
  });
});
