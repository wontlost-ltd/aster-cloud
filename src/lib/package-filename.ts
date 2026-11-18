/**
 * 策略包下载文件名（ADR 0059 P2）：从 aster-api 的 Content-Disposition 取文件名。
 * 纯函数、无服务端依赖：policy-api 客户端与浏览器端导出面板共用。
 */
const FALLBACK_PACKAGE_FILENAME = 'policy-package.zip';

/** 从 Content-Disposition 取文件名：RFC 5987 的 filename*=UTF-8''… 优先，其次 filename="…"。 */
export function packageFilename(contentDisposition: string | null): string {
  const header = contentDisposition ?? '';
  const extended = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (extended) {
    try {
      const decoded = decodeURIComponent(extended[1]!.trim());
      if (decoded) return decoded;
    } catch {
      // 非法百分号编码：退到 ASCII 回退名
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"/i.exec(header) ?? /filename\s*=\s*([^;]+)/i.exec(header);
  return plain?.[1]?.trim() || FALLBACK_PACKAGE_FILENAME;
}

