/**
 * LSP 网关 stdout 分帧：Content-Length 是 **UTF-8 字节数**。
 *
 * ★生产缺陷：网关把 stdout 拼成 JS 字符串、再按 Content-Length 切**字符**。
 *   中文一个字 3 字节、只占 1 个字符 → 切多了，消息尾部吞进下一条的头，
 *   浏览器收到粘连/截断的 JSON（zh 用户的每条含中文的消息都受影响）。
 */
import { describe, expect, it } from 'vitest';
import { createLspFrameDecoder } from '../../../lsp-server.mjs';

const frame = (obj: unknown) => {
  const body = Buffer.from(JSON.stringify(obj), 'utf-8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
};

describe('createLspFrameDecoder', () => {
  it('★含中文的两条消息在同一块里：各自完整、互不粘连', () => {
    const a = { jsonrpc: '2.0', method: 'window/logMessage', params: { message: '模块 已加载：规则 计算' } };
    const b = { jsonrpc: '2.0', id: 1, result: { contents: '规则 twice 给定 r 作为 Req' } };
    const out = createLspFrameDecoder().push(Buffer.concat([frame(a), frame(b)]));
    expect(out.map((s: string) => JSON.parse(s))).toEqual([a, b]);
  });

  it('★块边界切在多字节字符中间：不产生乱码', () => {
    const msg = { jsonrpc: '2.0', method: 'x', params: { t: '整数作为文本' } };
    const bytes = frame(msg);
    const cut = bytes.indexOf(Buffer.from('数')) + 1; // 落在「数」的 3 字节中间
    const dec = createLspFrameDecoder();
    expect(dec.push(bytes.subarray(0, cut))).toEqual([]);
    expect(dec.push(bytes.subarray(cut)).map((s: string) => JSON.parse(s))).toEqual([msg]);
  });

  it('头部大小写不敏感，残缺头等待后续数据', () => {
    const msg = { jsonrpc: '2.0', id: 2, result: null };
    const body = Buffer.from(JSON.stringify(msg));
    const dec = createLspFrameDecoder();
    expect(dec.push(Buffer.from('content-length: '))).toEqual([]);
    expect(dec.push(Buffer.concat([Buffer.from(`${body.length}\r\n\r\n`), body]))).toEqual([JSON.stringify(msg)]);
  });
});
