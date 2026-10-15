import { describe, it, expect } from 'vitest';
import { parseSSEFrame } from '@/hooks/useSSEStream';

describe('parseSSEFrame', () => {
  describe('W3C two-line frames (event: + data:)', () => {
    it('PromptScopeFilter rejection: surfaces message, not raw JSON', () => {
      const frame =
        'event: error\ndata: {"error":"out_of_scope","message":"请求未识别为 policy 相关，请描述具体的策略 / 规则 / 合规需求","rule_id":"off-topic-no-keywords"}';
      const e = parseSSEFrame(frame);
      expect(e?.type).toBe('error');
      // user-facing message wins over machine-readable error code
      expect(e?.error).toBe(
        '请求未识别为 policy 相关，请描述具体的策略 / 规则 / 合规需求'
      );
    });

    it('falls back to error code when message is absent', () => {
      const frame = 'event: error\ndata: {"error":"out_of_scope"}';
      const e = parseSSEFrame(frame);
      expect(e?.type).toBe('error');
      expect(e?.error).toBe('out_of_scope');
    });

    it('final event with validated flag', () => {
      const frame =
        'event: final\ndata: {"data":"Module x. Rule y given a: a > 0.","validated":true}';
      const e = parseSSEFrame(frame);
      expect(e?.type).toBe('final');
      expect(e?.data).toBe('Module x. Rule y given a: a > 0.');
      expect(e?.validated).toBe(true);
    });
  });

  describe('Quarkus single-line JSON (type inside payload)', () => {
    it('delta event from inline type field', () => {
      const frame = 'data: {"type":"delta","data":"hello"}';
      const e = parseSSEFrame(frame);
      expect(e?.type).toBe('delta');
      expect(e?.data).toBe('hello');
    });

    it('upstream_reached（#470 计费标记）：解析为该类型、不带内容', () => {
      const e = parseSSEFrame('data: {"type":"upstream_reached"}');
      expect(e?.type).toBe('upstream_reached');
      expect(e?.data).toBeUndefined();
      expect(e?.error).toBeUndefined();
    });

    it('meta 帧（ADR 0048 实际 model）：解析为 meta，不是内容也不是错误', () => {
      const e = parseSSEFrame('data: {"type":"meta","data":"gpt-4o"}');
      expect(e?.type).toBe('meta');
      expect(e?.error).toBeUndefined();
    });

    it('repair_start with progress data', () => {
      const frame = 'data: {"type":"repair_start","data":"2/5"}';
      const e = parseSSEFrame(frame);
      expect(e?.type).toBe('repair_start');
      expect(e?.data).toBe('2/5');
    });
  });

  describe('fallbacks', () => {
    it('returns null on empty frame', () => {
      expect(parseSSEFrame('')).toBeNull();
      expect(parseSSEFrame('   \n  ')).toBeNull();
    });

    it('SSE comment lines are skipped', () => {
      const frame = ': keep-alive\nevent: error\ndata: {"message":"hi"}';
      const e = parseSSEFrame(frame);
      expect(e?.type).toBe('error');
      expect(e?.error).toBe('hi');
    });

    it('non-JSON delta payload is preserved verbatim', () => {
      const frame = 'data: just a plain text chunk';
      const e = parseSSEFrame(frame);
      expect(e?.type).toBe('delta');
      expect(e?.data).toBe('just a plain text chunk');
    });
  });

  // 回归：LLM 逐 token 流式，token 常带前导空格（如 " is"）。SSE 规范只移除
  // data: 后「一个」前导空格，其余必须保留——否则 "Rule" + " is" 拼成
  // "Ruleis"（用户实测 AI 输出代码全丢空格的根因）。
  describe('token 前导空格保留（不丢空格）', () => {
    const accumulate = (frames: string[]) => {
      let content = '';
      for (const f of frames) {
        const e = parseSSEFrame(f);
        if (e?.data) content += e.data;
      }
      return content;
    };

    it('JSON delta：token 前导空格保留', () => {
      const toks = ['Rule', ' is', '_audit', ' given', ' resource'];
      const frames = toks.map(
        (t) => `data: ${JSON.stringify({ type: 'delta', data: t })}`,
      );
      expect(accumulate(frames)).toBe('Rule is_audit given resource');
    });

    it('原始文本 delta：token 前导空格保留（只去一个分隔空格）', () => {
      // 每帧 `data: <token>`，SSE 去掉冒号后一个空格，token 自身的前导空格保留。
      const toks = ['Rule', ' is', ' given', ' resource'];
      const frames = toks.map((t) => `data: ${t}`);
      expect(accumulate(frames)).toBe('Rule is given resource');
    });

    it('CRLF 帧：\\r 去除但内部空格保留', () => {
      const e = parseSSEFrame('data: {"type":"delta","data":" indented"}\r');
      expect(e?.data).toBe(' indented');
    });

    it('代码块缩进空格保留（多空格不塌缩）', () => {
      const e = parseSSEFrame(
        `data: ${JSON.stringify({ type: 'delta', data: '    Return true.' })}`,
      );
      expect(e?.data).toBe('    Return true.');
    });

    it('两行帧 event+data：data 值前导空格保留', () => {
      const e = parseSSEFrame('event: delta\ndata: {"type":"delta","data":" and"}');
      expect(e?.data).toBe(' and');
    });

    it('JSON delta 携带换行的代码块：换行+缩进+空格全保留（suggest 场景）', () => {
      // suggest 现与 generate 一致发 JSON delta；Jackson 把 \n 转义成 \\n，
      // SSE data 行仍单行，JSON.parse 后还原 \n + 缩进 + 词间空格。
      const code = 'Rule allow given actor as Text:\n  Return actor in ["a", "b"].';
      const e = parseSSEFrame(
        `data: ${JSON.stringify({ type: 'delta', data: code })}`,
      );
      expect(e?.data).toBe(code);
    });
  });

  // 帧分隔符 CRLF 兼容：stream buffer 用 `\r?\n\r?\n` 拆帧（见 startStream）。
  // 这里直接验证该正则对 LF/CRLF 空行都能正确拆分，且拆出的帧仍保留空格。
  describe('帧分隔符 CRLF 兼容', () => {
    const splitFrames = (buffer: string) => buffer.split(/\r?\n\r?\n/);

    it('CRLF 空行分隔的多帧被正确拆分', () => {
      const buffer =
        'data: {"type":"delta","data":" a"}\r\n\r\ndata: {"type":"delta","data":" b"}\r\n\r\n';
      const frames = splitFrames(buffer).filter((f) => f.trim());
      expect(frames).toHaveLength(2);
      expect(parseSSEFrame(frames[0])?.data).toBe(' a');
      expect(parseSSEFrame(frames[1])?.data).toBe(' b');
    });

    it('LF 空行分隔仍正常', () => {
      const buffer = 'data: {"type":"delta","data":" a"}\n\ndata: {"type":"delta","data":" b"}\n\n';
      const frames = splitFrames(buffer).filter((f) => f.trim());
      expect(frames).toHaveLength(2);
    });
  });
});
