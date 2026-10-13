// RAG 应答器（联网分支）测试。
//
// 锁的是**链路契约**而非措辞：请求打到既有护栏路由、只送模型需要的字段、
// SSE 逐帧解析、上游错误转异常（交给面板降级）、中止能真正断流。
//
// ★不 mock parseSSEFrame：用真实解析器喂真实 SSE 帧，否则测的是假管道。

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createDigitalHumanProvider } from '@/lib/assistant/digital-human';
import type { AssistantHit } from '@/lib/assistant/retrieval';

const hit = (i: number): AssistantHit => ({
  id: `doc:${i}`,
  kind: 'doc',
  title: `标题${i}`,
  subtitle: `摘要${i}`,
  href: `/zh/docs/p${i}`,
  score: 100 - i,
});

/** 把若干 SSE 帧拼成一个可读流（后端发 JSON delta）。 */
function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
  });
}

const delta = (s: string) => `data: ${JSON.stringify({ type: 'delta', data: s })}\n\n`;

function mockFetch(body: ReadableStream<Uint8Array> | null, ok = true, status = 200) {
  const fn = vi.fn().mockResolvedValue({ ok, status, body });
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function collect(gen: AsyncIterable<{ delta: string }>): Promise<string> {
  let out = '';
  for await (const c of gen) out += c.delta;
  return out;
}

afterEach(() => vi.unstubAllGlobals());

describe('digital human provider', () => {
  const p = createDigitalHumanProvider();
  const base = { query: '怎么回滚', locale: 'zh-CN', signal: new AbortController().signal };

  it('打到既有护栏路由（不另开裸通路）', async () => {
    const f = mockFetch(sseStream([delta('ok')]));
    await collect(p.answer({ ...base, groundingHits: [hit(1)] }));
    expect(f).toHaveBeenCalledOnce();
    expect(f.mock.calls[0][0]).toBe('/api/llm/assistant');
  });

  it('只送模型需要的三个字段（score/kind/id 不外发，省 prompt 体积）', async () => {
    const f = mockFetch(sseStream([delta('ok')]));
    await collect(p.answer({ ...base, groundingHits: [hit(1)] }));
    const sent = JSON.parse(f.mock.calls[0][1].body);
    expect(sent.groundingHits[0]).toEqual({
      title: '标题1', snippet: '摘要1', href: '/zh/docs/p1',
    });
    expect(sent.query).toBe('怎么回滚');
    expect(sent.locale).toBe('zh-CN');
  });

  it('★grounding 条数封顶 16（与后端 @Size 对齐，超出会被 400 拒）', async () => {
    const f = mockFetch(sseStream([delta('ok')]));
    const many = Array.from({ length: 40 }, (_, i) => hit(i));
    await collect(p.answer({ ...base, groundingHits: many }));
    expect(JSON.parse(f.mock.calls[0][1].body).groundingHits).toHaveLength(16);
  });

  it('逐帧累积增量', async () => {
    mockFetch(sseStream([delta('版本'), delta('与审批')]));
    expect(await collect(p.answer({ ...base, groundingHits: [] }))).toBe('版本与审批');
  });

  it('★upstream_reached 计费帧（#470）不进答案、不报错', async () => {
    mockFetch(sseStream(['data: {"type":"upstream_reached"}\n\n', delta('版本')]));
    expect(await collect(p.answer({ ...base, groundingHits: [] }))).toBe('版本');
  });

  it('★跨 chunk 的半截帧能正确拼回（不丢字、不吞空格）', async () => {
    // 一帧被网络切成两块到达——这是真实 SSE 的常态
    const whole = delta(' 保留 前导空格');
    const cut = Math.floor(whole.length / 2);
    mockFetch(sseStream([whole.slice(0, cut), whole.slice(cut)]));
    expect(await collect(p.answer({ ...base, groundingHits: [] }))).toBe(' 保留 前导空格');
  });

  it('末帧无尾随空行也不丢（收尾处理 buffer 残留）', async () => {
    mockFetch(sseStream([`data: ${JSON.stringify({ type: 'delta', data: '最后一句' })}`]));
    expect(await collect(p.answer({ ...base, groundingHits: [] }))).toBe('最后一句');
  });

  it('★上游 error 帧转异常（交面板降级，而不是把错误当答案显示）', async () => {
    mockFetch(sseStream([delta('部分'), `data: ${JSON.stringify({ type: 'error', error: '配额耗尽' })}\n\n`]));
    await expect(collect(p.answer({ ...base, groundingHits: [] }))).rejects.toThrow('配额耗尽');
  });

  it('★HTTP 非 2xx 抛异常（如未登录 401 → 面板降级为纯检索）', async () => {
    mockFetch(null, false, 401);
    await expect(collect(p.answer({ ...base, groundingHits: [] }))).rejects.toThrow('401');
  });

  it('signal 透传给 fetch（用户关面板能真正中止在途请求）', async () => {
    const f = mockFetch(sseStream([delta('x')]));
    const ac = new AbortController();
    await collect(p.answer({ ...base, groundingHits: [], signal: ac.signal }));
    expect(f.mock.calls[0][1].signal).toBe(ac.signal);
  });
});
