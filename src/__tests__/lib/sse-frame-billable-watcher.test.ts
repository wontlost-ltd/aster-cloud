/**
 * SSE 计费帧观察（#470）：请求到达第三方 AI（upstream_reached）或出现内容即计费。
 * 帧格式取自 aster-api 实际输出（LlmProxyService.toJson / AiAssistantResource.refusalStream）。
 */
import { describe, it, expect } from 'vitest';
import { createSseBillableWatcher, parseSSEFrame } from '@/lib/sse-frame';

const enc = new TextEncoder();
const feed = (...chunks: string[]) => {
  const w = createSseBillableWatcher();
  const seen = chunks.map((c) => w.push(enc.encode(c)));
  return { seen, finish: () => w.finish() };
};

describe('createSseBillableWatcher', () => {
  it('★只有一条 error 帧（未配置 key / BYOK 无效 / 连不上 provider）：不计费', () => {
    const { seen, finish } = feed('data: {"type":"error","error":"未配置 LLM API Key"}\n\n');
    expect(seen).toEqual([false]);
    expect(finish()).toBe(false);
  });

  it('★安全拒答（event: error + JSON）：不计费', () => {
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
    const w = createSseBillableWatcher();
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

  it('★upstream_reached 之后 provider 报错：已到达第三方，计费', () => {
    const { seen } = feed(
      'data: {"type":"upstream_reached"}\n\n',
      'data: {"type":"error","error":"LLM API 错误 (500)"}\n\n',
    );
    expect(seen).toEqual([true, true]);
  });

  it('★只有 upstream_reached、随后流就断了（用户断开 / provider 沉默）：计费', () => {
    const { seen, finish } = feed('data: {"type":"upstream_reached"}\n\n');
    expect(seen).toEqual([true]);
    expect(finish()).toBe(true);
  });

  it('★upstream_reached 之后 LLM 未生成内容：计费', () => {
    const { seen } = feed('data: {"type":"upstream_reached"}\n\ndata: {"type":"error","error":"LLM 未生成内容"}\n\n');
    expect(seen).toEqual([true]);
  });

  it('upstream_reached 帧被拆在两个 chunk：帧完整时才判定', () => {
    expect(feed('data: {"type":"upstream_', 'reached"}\n\n').seen).toEqual([false, true]);
  });

  it('旧版 aster-api（不发 upstream_reached）：仍按内容计费', () => {
    expect(feed('data: {"type":"error","error":"x"}\n\n').seen).toEqual([false]);
    expect(feed('data: {"type":"delta","data":"Rule"}\n\n').seen).toEqual([true]);
  });

  it('★meta 帧先于 upstream_reached 到达 → watcher.model() 为该 model，且计费判定不变', () => {
    const w = createSseBillableWatcher();
    expect(w.push(enc.encode('data: {"type":"meta","data":"gpt-4o"}\n\n'))).toBe(false);
    expect(w.model()).toBe('gpt-4o');
    expect(w.push(enc.encode('data: {"type":"upstream_reached"}\n\n'))).toBe(true);
    expect(w.model()).toBe('gpt-4o');
  });

  it('★旧版 api 无 meta 帧 → model() 为 null，计费判定与今天一致', () => {
    const w = createSseBillableWatcher();
    expect(w.push(enc.encode('data: {"type":"upstream_reached"}\n\n'))).toBe(true);
    expect(w.model()).toBeNull();
  });

  it('meta 与 upstream_reached 在同一 chunk → 两者都识别', () => {
    const w = createSseBillableWatcher();
    expect(w.push(enc.encode('data: {"type":"meta","data":"gpt-4o"}\n\ndata: {"type":"upstream_reached"}\n\n'))).toBe(true);
    expect(w.model()).toBe('gpt-4o');
  });

  it('meta 帧被 chunk 边界切开 → 拼接后仍识别', () => {
    const w = createSseBillableWatcher();
    expect(w.push(enc.encode('data: {"type":"me'))).toBe(false);
    expect(w.push(enc.encode('ta","data":"gpt-4o"}\n\n'))).toBe(false);
    expect(w.model()).toBe('gpt-4o');
  });

  describe('failed()：到达 provider 之后出现 error 帧 → 本次调用以失败记账（状态 api_error，仍计费）', () => {
    const REACHED = 'data: {"type":"upstream_reached"}\n\n';
    const run = (...chunks: string[]) => {
      const w = createSseBillableWatcher();
      chunks.forEach((c) => w.push(enc.encode(c)));
      w.finish();
      return w;
    };

    it('★upstream_reached 后 provider 报错（含 provider_rejected_model）→ failed', () => {
      expect(run(REACHED, 'data: {"type":"error","error":"provider_rejected_model"}\n\n').failed()).toBe(true);
    });

    it('★已有内容后中途失败 → failed', () => {
      expect(run(REACHED, 'data: {"type":"delta","data":"Rule"}\n\n', 'data: {"type":"error","error":"流式响应异常"}\n\n').failed()).toBe(true);
    });

    it('同一 chunk 里 upstream_reached + error → failed', () => {
      expect(run(REACHED + 'data: {"type":"error","error":"LLM 未生成内容"}\n\n').failed()).toBe(true);
    });

    it('末尾 error 帧没有空行收尾 → finish 时识别为 failed', () => {
      expect(run(REACHED, 'data: {"type":"error","error":"x"}').failed()).toBe(true);
    });

    it('正常完成 / 只有 upstream_reached（用户断开）→ 不算 failed', () => {
      expect(run(REACHED, 'data: {"type":"delta","data":"a"}\n\n', 'data: {"type":"final","data":"a","validated":true}\n\n').failed()).toBe(false);
      expect(run(REACHED).failed()).toBe(false);
    });

    it('计费前的 error（未到达 provider）不算 failed——那一笔本就不记', () => {
      expect(run('data: {"type":"error","error":"未配置 LLM API Key"}\n\n').failed()).toBe(false);
    });

    it('validation_error / repair_start 不是失败（repair 流程的正常帧）', () => {
      expect(run(REACHED, 'data: {"type":"validation_error","error":"语法错误"}\n\n', 'data: {"type":"repair_start","data":"2/3"}\n\n').failed()).toBe(false);
    });
  });

  describe('aster-api 安全拒答：单个裸 JSON item → 单条 data: 帧（不再是 data: data: 双层包裹）', () => {
    const REFUSAL = 'data: {"type":"error","error":"out_of_scope","message":"超出范围","rule_id":"r1"}\n\n';

    it('parseSSEFrame 解析为 error 事件；error 字段取面向用户的 message（机器码 out_of_scope 只用于识别）', () => {
      expect(parseSSEFrame(REFUSAL)).toEqual({ type: 'error', data: undefined, error: '超出范围', validated: undefined, code: 'out_of_scope', message: '超出范围' });
    });

    it('无 message 时 error 字段回落为机器码 out_of_scope', () => {
      expect(parseSSEFrame('data: {"type":"error","error":"out_of_scope","rule_id":"r1"}\n\n')).toMatchObject({
        type: 'error',
        error: 'out_of_scope',
      });
    });

    it('★拒答 error 帧先于任何计费帧到达 → 不计费、failed() 为 false（拒答不记账）', () => {
      const w = createSseBillableWatcher();
      expect(w.push(enc.encode(REFUSAL))).toBe(false);
      expect(w.finish()).toBe(false);
      expect(w.failed()).toBe(false);
    });
  });
});
