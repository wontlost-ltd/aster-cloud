/**
 * LSP 网关应用层心跳：网关自己应答 `$/aster/ping`，不转发给语言服务器，也不刷新闲置计时
 * （否则每 15 秒一次的心跳会让 #657 的闲置超时永远不触发）。
 */
import { describe, it, expect } from 'vitest';
import { heartbeatReply, LSP_HEARTBEAT_METHOD } from '../../../lsp-server.mjs';
import { LSP_HEARTBEAT_METHOD as CLIENT_METHOD } from '@/lib/lsp-reconnect';

describe('heartbeatReply', () => {
  it('方法名与前端一致', () => {
    expect(LSP_HEARTBEAT_METHOD).toBe(CLIENT_METHOD);
  });

  it('带 id 的心跳请求返回同 id 的空结果', () => {
    const raw = JSON.stringify({ jsonrpc: '2.0', id: 7, method: LSP_HEARTBEAT_METHOD });
    expect(JSON.parse(heartbeatReply(raw)!)).toEqual({ jsonrpc: '2.0', id: 7, result: null });
  });

  it('字符串 id 原样回显', () => {
    const raw = JSON.stringify({ jsonrpc: '2.0', id: 'a', method: LSP_HEARTBEAT_METHOD });
    expect(JSON.parse(heartbeatReply(raw)!).id).toBe('a');
  });

  it('其他 LSP 消息返回 null（继续转发并刷新活动时间）', () => {
    expect(heartbeatReply(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }))).toBeNull();
    expect(heartbeatReply(JSON.stringify({ jsonrpc: '2.0', method: 'textDocument/didChange', params: { text: LSP_HEARTBEAT_METHOD } }))).toBeNull();
  });

  it('无 id 的心跳通知、非法 JSON、数组批量都不当作心跳', () => {
    expect(heartbeatReply(JSON.stringify({ jsonrpc: '2.0', method: LSP_HEARTBEAT_METHOD }))).toBeNull();
    expect(heartbeatReply(`{"method":"${LSP_HEARTBEAT_METHOD}"`)).toBeNull();
    expect(heartbeatReply(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: LSP_HEARTBEAT_METHOD }]))).toBeNull();
  });
});
