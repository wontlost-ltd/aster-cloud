/**
 * 把一个 WebSocket 帧拆成若干条 JSON-RPC 消息。
 *
 * 网关按字节正确分帧后，一帧就是一条消息（见 lsp-server.mjs 的 createLspFrameDecoder），
 * 这里只是兜底：若一帧里拼了多条，按顶层花括号配对切分。
 * ★切分时必须跳过字符串字面量（含转义），否则消息正文里的花括号会让配对错位。
 */
export function splitJsonMessages(data: string): unknown[] {
  try {
    return [JSON.parse(data)];
  } catch {
    // 不是单条完整 JSON，进入逐条切分
  }

  const messages: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0) messages.push(...parseOrSkip(data.slice(start, i + 1)));
    }
  }
  return messages;
}

function parseOrSkip(segment: string): unknown[] {
  try {
    return [JSON.parse(segment)];
  } catch {
    return [];
  }
}
