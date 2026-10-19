/**
 * SSE text/event-stream 帧解析（浏览器 useSSEStream 与服务端 llm-sse-proxy 共用）。
 */

/**
 * upstream_reached：aster-api 已连上第三方 AI，本次调用计入配额（#470）。不带内容，
 * 浏览器侧各消费者按未知类型忽略；只供 llm-sse-proxy 计费判断。
 * meta：aster-api 首帧回传实际发出的 model（ADR 0048），data 为 model 名；非内容、非错误，
 * 只供 llm-sse-proxy 记账用，浏览器侧忽略。
 */
export type SSEEventType = 'delta' | 'validation_error' | 'repair_start' | 'final' | 'error' | 'upstream_reached' | 'meta';

export interface SSEEvent {
  type: SSEEventType;
  data?: string;
  error?: string;
  validated?: boolean;
  /** error 帧的机器可读码（payload.error）；`error` 字段为展示文本（message 优先），二者不可混用。 */
  code?: string;
  /** error 帧的 payload.message：新版 aster-api 为 provider 脱敏原话。 */
  message?: string;
  /** error 帧的 payload.providerErrorType（如 invalid_request_error）。 */
  providerErrorType?: string;
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
      providerErrorType?: string;
    };
    // PromptScopeFilter 返回 { error: "out_of_scope", message: "...", rule_id: "..." }
    // 用 message 作为 user-facing 文案，error 仅作为机器可读的 code
    // error 帧：event.error 是展示文本（有 provider message 时即该原话），机器码在 event.code；
    // 需要按码分支的消费者必须用 code / errorDetail，不能拿 error 比较。
    const userMessage = parsed.message ?? parsed.error;
    return {
      type: eventType ?? parsed.type ?? 'delta',
      data: parsed.data,
      error: userMessage,
      validated: parsed.validated,
      ...(typeof parsed.error === 'string' ? { code: parsed.error } : {}),
      ...(typeof parsed.message === 'string' ? { message: parsed.message } : {}),
      ...(typeof parsed.providerErrorType === 'string' ? { providerErrorType: parsed.providerErrorType } : {}),
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
 * 这一帧是否说明本次调用要计入 AI 配额（#470）。
 *
 * <p>规则：请求到达了第三方 AI 就计费——不论随后是 provider 报错、超时、没有内容，
 * 还是用户中途断开。aster-api 在连上 provider 时发 upstream_reached 帧标记这一点。
 * 在它之前就结束的（安全拒答、未配置 key、BYOK 无效、连不上 provider）不计。
 *
 * <p>内容帧也算：内容必然来自 provider。这让尚未发出 upstream_reached 的旧版 aster-api
 * 保持原有计费口径，两个仓库可以任意顺序部署。
 */
export function isBillableEvent(event: SSEEvent | null): boolean {
  return !!event && (event.type === 'upstream_reached' || isContentEvent(event));
}

/**
 * 逐 chunk 观察一条 SSE 字节流：是否出现过计费帧（{@link isBillableEvent}），以及计费之后是否失败。
 *
 * <p>帧可能被拆在多个 chunk 里，多字节字符也可能被切开，故按流式解码并缓冲不完整的帧。
 * 见到计费帧后仍继续解析——决定记账状态的 error 帧可能晚到；一旦判定失败就不再解析、不再缓冲。
 * meta 帧恒先于计费帧，故计费时 model 已定。
 */
export function createSseBillableWatcher(): {
  /** 喂入一个 chunk，返回到目前为止是否已出现计费帧。 */
  push: (chunk: Uint8Array) => boolean;
  /** 流结束时调用：解析末尾没有空行收尾的最后一帧。 */
  finish: () => boolean;
  /** 首个 meta 帧携带的实际 model；无则 null。 */
  model: () => string | null;
  /** 计费帧之后出现过 error 帧（provider 报错 / 拒绝模型 / 中途失败）→ 本次按 api_error 记账。 */
  failed: () => boolean;
} {
  const decoder = new TextDecoder();
  let buffer = '';
  let seen = false;
  let failed = false;
  let model: string | null = null;
  const scan = (frames: string[]) => {
    for (const frame of frames) {
      const ev = parseSSEFrame(frame);
      // meta 帧（ADR 0048）：aster-api 首帧回传实际发出的 model，先于计费帧；只取第一次。
      if (ev?.type === 'meta' && model === null && typeof ev.data === 'string' && ev.data) model = ev.data;
      // 计费前的 error（未到达 provider）不记账，故只看计费之后的 error。
      if (seen && ev?.type === 'error') failed = true;
      if (isBillableEvent(ev)) seen = true;
    }
  };
  return {
    push(chunk) {
      if (failed) return true;
      buffer += decoder.decode(chunk, { stream: true });
      const frames = buffer.split(FRAME_SEPARATOR);
      buffer = frames.pop() ?? '';
      scan(frames);
      if (failed) buffer = '';
      return seen;
    },
    finish() {
      if (failed) return true;
      buffer += decoder.decode();
      scan([buffer]);
      buffer = '';
      return seen;
    },
    model: () => model,
    failed: () => failed,
  };
}
