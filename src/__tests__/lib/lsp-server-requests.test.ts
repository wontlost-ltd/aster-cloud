/**
 * 服务端→客户端请求的应答（JSON-RPC：带 id 的请求必须有且仅有一个响应）。
 *
 * ★生产实测：aster-lang-ts 服务端在 initialized 后发 client/registerCapability，
 *   客户端把它当通知吞掉、从不回复——请求在服务端永久挂起。
 */
import { describe, expect, it } from 'vitest';
import { respondToServerRequest } from '@/lib/lsp-server-requests';

describe('respondToServerRequest', () => {
  it('client/registerCapability 回 result:null', () => {
    expect(respondToServerRequest({ jsonrpc: '2.0', id: 7, method: 'client/registerCapability', params: { registrations: [] } }))
      .toEqual({ jsonrpc: '2.0', id: 7, result: null });
  });

  it('client/unregisterCapability 回 result:null', () => {
    expect(respondToServerRequest({ jsonrpc: '2.0', id: 'a', method: 'client/unregisterCapability', params: {} }))
      .toEqual({ jsonrpc: '2.0', id: 'a', result: null });
  });

  it('workspace/configuration 按 items 个数回 null 数组', () => {
    expect(respondToServerRequest({ jsonrpc: '2.0', id: 3, method: 'workspace/configuration', params: { items: [{ section: 'a' }, { section: 'b' }] } }))
      .toEqual({ jsonrpc: '2.0', id: 3, result: [null, null] });
  });

  it('window/workDoneProgress/create 回 result:null', () => {
    expect(respondToServerRequest({ jsonrpc: '2.0', id: 4, method: 'window/workDoneProgress/create', params: { token: 't' } }))
      .toEqual({ jsonrpc: '2.0', id: 4, result: null });
  });

  it('未知请求回 MethodNotFound（-32601），而不是沉默', () => {
    const r = respondToServerRequest({ jsonrpc: '2.0', id: 5, method: 'x/unknown' });
    expect(r).toMatchObject({ jsonrpc: '2.0', id: 5, error: { code: -32601 } });
  });

  it('通知（无 id）不应答', () => {
    expect(respondToServerRequest({ jsonrpc: '2.0', method: 'window/logMessage', params: {} })).toBeNull();
  });

  it('响应（有 id 无 method）不应答', () => {
    expect(respondToServerRequest({ jsonrpc: '2.0', id: 1, result: {} })).toBeNull();
  });
});
