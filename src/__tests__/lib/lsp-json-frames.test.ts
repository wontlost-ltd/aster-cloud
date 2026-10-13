/**
 * WebSocket 帧里的 JSON 拆分：兜底处理一帧多条消息。
 *
 * ★旧实现数 { } 时不跳过字符串，hover 的 markdown / 诊断信息里一出现花括号
 *   就会切错，整批消息被丢弃。
 */
import { describe, expect, it } from 'vitest';
import { splitJsonMessages } from '@/lib/lsp-json-frames';

describe('splitJsonMessages', () => {
  it('单条消息原样返回', () => {
    expect(splitJsonMessages('{"id":1,"result":null}')).toEqual([{ id: 1, result: null }]);
  });

  it('★字符串里的花括号与转义引号不影响切分', () => {
    const a = { id: 1, result: { contents: '定义 { a } 与 "引号\\" }' } };
    const b = { method: 'window/logMessage', params: { message: '}{' } };
    expect(splitJsonMessages(JSON.stringify(a) + JSON.stringify(b))).toEqual([a, b]);
  });

  it('残缺片段被跳过，不影响其余完整消息', () => {
    expect(splitJsonMessages('{"id":2,"result":1}{"id":3,')).toEqual([{ id: 2, result: 1 }]);
  });
});
