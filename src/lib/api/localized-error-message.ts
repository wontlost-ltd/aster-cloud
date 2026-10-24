/** 按稳定错误码选择本地化文案，未命中时回退到服务端消息。 */
export function localizedErrorMessage(
  code: unknown,
  messagesByCode: Readonly<Record<string, string>>,
  fallbackMessage: string,
): string {
  if (typeof code === 'string' && messagesByCode[code]) {
    return messagesByCode[code];
  }
  return fallbackMessage;
}
