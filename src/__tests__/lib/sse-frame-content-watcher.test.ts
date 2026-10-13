/**
 * SSE 内容帧观察（#470）：只有用户能看到的产出才算「有产出」。
 * 帧格式取自 aster-api 实际输出（LlmProxyService.toJson / AiAssistantResource.refusalStream）。
 */
import { describe, it, expect } from 'vitest';
import { createSseContentWatcher } from '@/lib/sse-frame';

const enc = new TextEncoder();
const feed = (...chunks: string[]) => {
  const w = createSseContentWatcher();
  const seen = chunks.map((c) => w.push(enc.encode(c)));
  return { seen, finish: () => w.finish() };
};

describe('createSseContentWatcher', () => {
  it('★只有一条 error 帧（未配置 key / BYOK 无效 / LLM 调用失败）：无产出', () => {
    const { seen, finish } = feed('data: {"type":"error","error":"未配置 LLM API Key"}\n\n');
    expect(seen).toEqual([false]);
    expect(finish()).toBe(false);
  });

  it('★安全拒答（event: error + JSON）：无产出', () => {
    const { seen, finish } = feed('event: error\ndata: {"error":"out_of_scope","message":"超出范围","rule_id":"r1"}\n\n');
    expect(seen).toEqual([false]);
    expect(finish()).toBe(false);
  });

  it('空 delta、validation_error、repair_start：都不算产出', () => {
    const { seen } = feed(
      'data: {"type":"delta","data":""}\n\n',
      'data: {"type":"validation_error","error":"语法错误"}\n\n',
      'data: {"type":"repair_start","data":"2/5"}\n\n',
    );
    expect(seen).toEqual([false, false, false]);
  });

  it('★非空 delta 即有产出', () => {
    expect(feed('data: {"type":"delta","data":"Rule"}\n\n').seen).toEqual([true]);
  });

  it('error 之后再来 delta：在 delta 处才判为有产出', () => {
    expect(feed('data: {"type":"error","error":"x"}\n\n', 'data: {"type":"delta","data":"ok"}\n\n').seen).toEqual([false, true]);
  });

  it('★帧被逐字节拆开（含中文）：帧完整前不提前判定，完整后判定', () => {
    const bytes = enc.encode('data: {"type":"delta","data":"规则 计算"}\n\n');
    const w = createSseContentWatcher();
    const seen = [...bytes].map((b) => w.push(new Uint8Array([b])));
    expect(seen.slice(0, -1).every((s) => !s)).toBe(true);
    expect(seen.at(-1)).toBe(true);
  });

  it('★末尾 final 没有空行收尾：finish 时判为有产出', () => {
    const { seen, finish } = feed('data: {"type":"final","data":"Module m.","validated":true}');
    expect(seen).toEqual([false]);
    expect(finish()).toBe(true);
  });

  it('CRLF 分隔与旧式 event: delta + 文本 data 也识别', () => {
    expect(feed('data: {"type":"delta","data":"a"}\r\n\r\n').seen).toEqual([true]);
    expect(feed('event: delta\ndata: hi\n\n').seen).toEqual([true]);
  });
});
