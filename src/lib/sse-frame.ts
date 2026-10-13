/**
 * SSE text/event-stream 帧解析（浏览器 useSSEStream 与服务端 llm-sse-proxy 共用）。
 */

export type SSEEventType = 'delta' | 'validation_error' | 'repair_start' | 'final' | 'error';

export interface SSEEvent {
  type: SSEEventType;
  data?: string;
  error?: string;
  validated?: boolean;
}

/**
 * 解析 SSE text/event-stream 帧到结构化 event。
 *
 * aster-api 同时使用两种格式：
 *   1) 双行 W3C 标准：
 *        event: error
 *        data: {"error":"out_of_scope","message":"...","rule_id":"..."}
 *      解析需按"帧"（两个 \n 分隔）而非按"行"。
 *   2) 单行 Quarkus JSON：
 *        data: {"type":"delta","data":"..."}
 *      此时 type 由 payload 自身携带。
 *
 * 兼容做法：从一段文本中提取 `event:` 行（如有）作为 type override，
 * 把所有 `data:` 行的内容拼接为 payload，再尝试 JSON.parse。
 */
export function parseSSEFrame(frame: string): SSEEvent | null {
  // 只去掉帧首尾的换行/回车用于「空帧」判断，不能用 trim()——data 值里的
  // 前导/尾随空格是有意义的（LLM 逐 token 流式，token 常带前导空格如 " is"，
  // trim 掉会把 "Rule is" 拼成 "Ruleis"）。
  if (!frame.replace(/[\r\n]/g, '').trim()) return null;

  let eventType: SSEEventType | null = null;
  const dataParts: string[] = [];

  // SSE 行以 \n 分隔，可能带 \r（CRLF）。逐行按字段解析，遵循 SSE 规范：
  // 字段名后的冒号，其后「一个」可选前导空格被移除，其余空格保留。
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.replace(/\r$/, ''); // 去掉行尾 \r，保留内部空格
    if (!line || line.startsWith(':')) continue; // 空行 / SSE 注释
    const colon = line.indexOf(':');
    if (colon === -1) continue; // 无冒号的字段行按 SSE 规范整行为字段名、值空，忽略
    const field = line.slice(0, colon);
    // 值 = 冒号后内容，移除「恰好一个」前导空格（SSE 规范），保留其余空格。
    let value = line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      const v = value.trim(); // 事件类型是枚举 token，可安全 trim
      if (v === 'delta' || v === 'validation_error' || v === 'repair_start' || v === 'final' || v === 'error') {
        eventType = v;
      }
    } else if (field === 'data') {
      dataParts.push(value); // ★ 不 trim：保留 token 前后有意义的空格
    }
  }

  const frameTrimmedForFallback = frame.trim();

  if (dataParts.length === 0) {
    // 既没 event: 也没 data:（或全空），按纯文本 delta 处理。此回退分支是
    // 非标准整帧兜底，用 trim 后的帧文本即可（不涉及逐 token 拼接）。
    return eventType
      ? { type: eventType }
      : { type: 'delta', data: frameTrimmedForFallback };
  }

  const payload = dataParts.join('\n');

  // 尝试 JSON.parse 拿结构化字段
  try {
    const parsed = JSON.parse(payload) as Partial<SSEEvent> & {
      error?: string;
      message?: string;
      rule_id?: string;
    };
    // PromptScopeFilter 返回 { error: "out_of_scope", message: "...", rule_id: "..." }
    // 用 message 作为 user-facing 文案，error 仅作为机器可读的 code
    const userMessage = parsed.message ?? parsed.error;
    return {
      type: eventType ?? parsed.type ?? 'delta',
      data: parsed.data,
      error: userMessage,
      validated: parsed.validated,
    };
  } catch {
    // 非 JSON：当 type 提示是 delta 时拼回 content；否则带 event type 抛错
    if (eventType && eventType !== 'delta') {
      return { type: eventType, error: payload };
    }
    return { type: 'delta', data: payload };
  }
}

/** SSE 帧之间以空行分隔（LF 或 CRLF）。 */
const FRAME_SEPARATOR = /\r?\n\r?\n/;

/**
 * 是否为用户能看到的产出：非空的 delta，或带内容的 final。
 * error / validation_error / repair_start 以及空 delta 都不算。
 */
export function isContentEvent(event: SSEEvent | null): boolean {
  return !!event && (event.type === 'delta' || event.type === 'final') && !!event.data;
}

/**
 * 逐 chunk 观察一条 SSE 字节流里是否出现过内容帧（{@link isContentEvent}）。
 *
 * <p>帧可能被拆在多个 chunk 里，多字节字符也可能被切开，故按流式解码并缓冲不完整的帧。
 * 一旦见到内容帧就不再解析、不再缓冲。
 */
export function createSseContentWatcher(): {
  /** 喂入一个 chunk，返回到目前为止是否已出现内容帧。 */
  push: (chunk: Uint8Array) => boolean;
  /** 流结束时调用：解析末尾没有空行收尾的最后一帧。 */
  finish: () => boolean;
} {
  const decoder = new TextDecoder();
  let buffer = '';
  let seen = false;
  const scan = (frames: string[]) => {
    seen = frames.some((frame) => isContentEvent(parseSSEFrame(frame)));
  };
  return {
    push(chunk) {
      if (seen) return true;
      buffer += decoder.decode(chunk, { stream: true });
      const frames = buffer.split(FRAME_SEPARATOR);
      buffer = frames.pop() ?? '';
      scan(frames);
      if (seen) buffer = '';
      return seen;
    },
    finish() {
      if (seen) return true;
      buffer += decoder.decode();
      scan([buffer]);
      buffer = '';
      return seen;
    },
  };
}
