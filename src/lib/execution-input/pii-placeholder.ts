/**
 * 打码视图里的 `$pii` 占位（ADR 0042 §11 D2）：`{ $pii: { level, category? } }`，`level: 'unknown'` 表示未声明类型。
 * 审批输入面板与执行日志共用同一识别口径。纯函数，可在客户端使用。
 */

/**
 * 执行日志视图里，一个对象的全部未声明键合并后的占位键（键名本身可能是 PII，不下发，cloud#754）。
 */
export const UNDECLARED_KEY = '$undeclared';

export interface PiiPlaceholder {
  readonly level: string;
  readonly category?: string;
}

/** 值是唯一键为 `$pii` 且带字符串 level 的对象时返回占位内容，否则 null。 */
export function piiOf(value: unknown): PiiPlaceholder | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  const pii = (value as Record<string, unknown>).$pii;
  if (keys.length !== 1 || typeof pii !== 'object' || pii === null) return null;
  const level = (pii as Record<string, unknown>).level;
  const category = (pii as Record<string, unknown>).category;
  return typeof level === 'string' ? { level, ...(typeof category === 'string' ? { category } : {}) } : null;
}
