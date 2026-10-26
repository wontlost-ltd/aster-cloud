/**
 * 执行页输入的纯逻辑（#635）：JSON 文本是输入的唯一状态，表单模式是它的视图。
 */

export type FormValues = Record<string, unknown>;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 输入的唯一状态是 JSON 文本（#635）：表单模式把它解析成对象来展示、编辑后再写回文本，
 * 两种模式看到的永远是同一份输入。文本不是 JSON 对象时返回 null（表单无法展示）。
 */
export function parseFormValues(input: string): FormValues | null {
  try {
    const parsed: unknown = JSON.parse(input);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 表单编辑一个参数（fieldName 为 null）或结构参数的一个字段，返回新的 JSON 文本。 */
export function withFormField(input: string, paramName: string, fieldName: string | null, value: unknown): string {
  const current = parseFormValues(input) ?? {};
  const param = current[paramName];
  const next = fieldName === null
    ? value
    : { ...(isPlainObject(param) ? param : {}), [fieldName]: value };
  return JSON.stringify({ ...current, [paramName]: next }, null, 2);
}

/**
 * 数字输入框里的文本 → 输入值：是完整的数字就存数字，否则原样存文本
 * （如正在输入的 "-"、"1."），不把半成品强行变成 0。
 */
export function numberFieldValue(text: string, integer: boolean): number | string {
  const pattern = integer ? /^-?\d+$/ : /^-?\d+(\.\d+)?$/;
  return pattern.test(text.trim()) ? Number(text) : text;
}

/** 执行结果的展示文本：字符串原样；运行时枚举值对象（`{_enum, value, variant}`）只显示成员名；其余格式化为 JSON。 */
export function formatResultValue(value: unknown): string {
  if (typeof value === 'string') return value;
  const member = isPlainObject(value) && typeof value._enum === 'string' ? value.variant ?? value.value : undefined;
  return typeof member === 'string' ? member : JSON.stringify(value, null, 2);
}
