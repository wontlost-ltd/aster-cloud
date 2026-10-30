import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LSP_DEBUG_STORAGE_KEY,
  isLspDebugEnabled,
  logLspMessage,
  type LspConsoleSink,
} from '@/lib/lsp-log-message';

function makeSink() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } satisfies Record<keyof LspConsoleSink, unknown>;
}

afterEach(() => {
  vi.unstubAllEnvs();
  localStorage.clear();
});

describe('logLspMessage 级别映射', () => {
  it('Error -> console.error，Warning -> console.warn，始终输出', () => {
    const sink = makeSink();
    logLspMessage({ type: 1, message: 'boom' }, { debug: false, sink });
    logLspMessage({ type: 2, message: 'careful' }, { debug: false, sink });
    expect(sink.error).toHaveBeenCalledWith('[LSP Error]', 'boom');
    expect(sink.warn).toHaveBeenCalledWith('[LSP Warning]', 'careful');
  });

  it('调试关闭时 Info/Log 与未知类型都不打印', () => {
    const sink = makeSink();
    logLspMessage({ type: 3, message: '{"level":"INFO"}' }, { debug: false, sink });
    logLspMessage({ type: 4, message: '[TypecheckCache] Cached' }, { debug: false, sink });
    logLspMessage({ message: 'no type' }, { debug: false, sink });
    for (const fn of [sink.error, sink.warn, sink.info, sink.debug]) expect(fn).not.toHaveBeenCalled();
  });

  it('调试开启时 Info -> console.info，Log -> console.debug', () => {
    const sink = makeSink();
    logLspMessage({ type: 3, message: 'i' }, { debug: true, sink });
    logLspMessage({ type: 4, message: 'l' }, { debug: true, sink });
    expect(sink.info).toHaveBeenCalledWith('[LSP Info]', 'i');
    expect(sink.debug).toHaveBeenCalledWith('[LSP Log]', 'l');
  });

  it('缺失 message 时输出空串而不抛错', () => {
    const sink = makeSink();
    logLspMessage({ type: 1 }, { sink });
    expect(sink.error).toHaveBeenCalledWith('[LSP Error]', '');
  });
});

describe('isLspDebugEnabled', () => {
  it('生产/测试环境默认关闭', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(isLspDebugEnabled()).toBe(false);
    vi.stubEnv('NODE_ENV', 'test');
    expect(isLspDebugEnabled()).toBe(false);
  });

  it('开发环境开启', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(isLspDebugEnabled()).toBe(true);
  });

  it('localStorage aster:lsp-debug=1 开启，其他值不开启', () => {
    vi.stubEnv('NODE_ENV', 'production');
    localStorage.setItem(LSP_DEBUG_STORAGE_KEY, '1');
    expect(isLspDebugEnabled()).toBe(true);
    localStorage.setItem(LSP_DEBUG_STORAGE_KEY, '0');
    expect(isLspDebugEnabled()).toBe(false);
  });

  it('localStorage 访问抛错时视为关闭', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(isLspDebugEnabled()).toBe(false);
    spy.mockRestore();
  });

  it('默认输出路径遵循开关：生产默认静默，开关打开后打印 Info', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    logLspMessage({ type: 3, message: 'x' });
    expect(info).not.toHaveBeenCalled();
    localStorage.setItem(LSP_DEBUG_STORAGE_KEY, '1');
    logLspMessage({ type: 3, message: 'x' });
    expect(info).toHaveBeenCalledWith('[LSP Info]', 'x');
    info.mockRestore();
  });
});
