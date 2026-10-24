import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeColumnRead } from '@/lib/safe-column-read';

describe('safeColumnRead', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['直接错误码', Object.assign(new Error('missing'), { code: '42703' })],
    ['cause 错误码', Object.assign(new Error('wrapped'), { cause: { code: '42703' } })],
  ])('%s 时回退并告警一次', async (_name, error) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fallback = vi.fn().mockResolvedValue('旧投影');
    await expect(safeColumnRead(() => Promise.reject(error), fallback, 'new_column')).resolves.toBe('旧投影');
    expect(fallback).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith('[safe-column-read] 列缺失，使用回退投影', { column: 'new_column' });
  });

  it('其他错误原样抛出', async () => {
    const error = Object.assign(new Error('connection lost'), { code: '08006' });
    await expect(safeColumnRead(() => Promise.reject(error), vi.fn(), 'column')).rejects.toBe(error);
  });

  it('成功路径不告警', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(safeColumnRead(() => Promise.resolve('新投影'), vi.fn(), 'column')).resolves.toBe('新投影');
    expect(warn).not.toHaveBeenCalled();
  });
});
