/**
 * 服务端→客户端请求的应答构造（纯函数，便于直接断言）。
 *
 * JSON-RPC 要求：带 id 且带 method 的消息是**请求**，接收方必须回且仅回一个响应。
 * 之前 useAsterLSP 把这类消息当通知处理、从不回复，服务端的
 * client/registerCapability 请求因此永久挂起。
 *
 * 本客户端不支持动态注册（initialize 时已如实声明 dynamicRegistration: false），
 * 所以对注册/注销只做确认；不认识的请求按规范回 MethodNotFound，而不是沉默。
 */

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC 标准错误码：方法不存在 */
export const METHOD_NOT_FOUND = -32601;

/**
 * 为服务端请求构造应答；消息不是请求（通知或响应）时返回 null。
 */
export function respondToServerRequest(message: JsonRpcMessage): JsonRpcMessage | null {
  if (message.id === undefined || message.method === undefined) return null;
  const { id, method } = message;

  switch (method) {
    case 'client/registerCapability':
    case 'client/unregisterCapability':
    case 'window/workDoneProgress/create':
    case 'window/showMessageRequest':
      return { jsonrpc: '2.0', id, result: null };
    case 'workspace/configuration': {
      // 每个 item 对应一个配置值；客户端无配置可给，逐项回 null（服务端走默认值）。
      const items = (message.params as { items?: unknown[] } | undefined)?.items ?? [];
      return { jsonrpc: '2.0', id, result: items.map(() => null) };
    }
    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: METHOD_NOT_FOUND, message: `Unhandled server request: ${method}` },
      };
  }
}
