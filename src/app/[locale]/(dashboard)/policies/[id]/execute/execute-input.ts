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

/** 解析 JSON 文本（任意 JSON 值）；不可解析时 ok=false。 */
export function parseJsonInput(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
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
 * （如正在输入的 "-"、"1."），不把半成品强行变成 0。执行前由 {@link normalizeNumberFields} 收口。
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

/** 表单字段的数字类别：按类型名识别（与表单渲染同一口径）；非数字类型为 null。 */
export function numberKind(typeName: string): 'integer' | 'decimal' | null {
  const lower = typeName.toLowerCase();
  if (['int', 'integer', 'long', '整数', '长整数', 'ganzzahl', 'langzahl'].some((t) => lower.includes(t))) return 'integer';
  if (['double', 'float', 'decimal', '小数', '浮点数', 'dezimal'].some((t) => lower.includes(t))) return 'decimal';
  return null;
}

/** 数字收口只需要参数表的这些信息。 */
export interface NumberFieldSchema {
  name: string;
  type: string;
  typeKind: string;
  fields?: ReadonlyArray<{ name: string; type: string; typeKind: string }>;
}

/** 表单里的一个数字字段：id 与表单控件 id 一致（结构字段为 `参数-字段`），label 为界面显示名。 */
interface NumberSlot {
  id: string;
  label: string;
  integer: boolean;
  read: (values: FormValues) => unknown;
  write: (values: FormValues, value: number) => FormValues;
}

function structFieldSlots(param: NumberFieldSchema): NumberSlot[] {
  const struct = (values: FormValues): FormValues => (isPlainObject(values[param.name]) ? values[param.name] as FormValues : {});
  return (param.fields ?? []).flatMap((field) => {
    const kind = field.typeKind === 'enum' ? null : numberKind(field.type);
    if (!kind) return [];
    return [{
      id: `${param.name}-${field.name}`,
      label: field.name,
      integer: kind === 'integer',
      read: (values: FormValues) => struct(values)[field.name],
      write: (values: FormValues, value: number) => ({ ...values, [param.name]: { ...struct(values), [field.name]: value } }),
    }];
  });
}

function paramSlots(param: NumberFieldSchema): NumberSlot[] {
  if (param.typeKind === 'struct') return structFieldSlots(param);
  const kind = param.typeKind === 'enum' ? null : numberKind(param.type);
  if (!kind) return [];
  return [{
    id: param.name,
    label: param.name,
    integer: kind === 'integer',
    read: (values) => values[param.name],
    write: (values, value) => ({ ...values, [param.name]: value }),
  }];
}

/** 文本形式的数字（含指数写法 1e3）→ 有限数字；整数字段要求整数。不是合法数字时 null。 */
function parseNumberText(text: string, integer: boolean): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) return null;
  return value;
}

export type NumberNormalization =
  | { ok: true; values: FormValues }
  | { ok: false; invalid: Array<{ id: string; label: string }> };

/**
 * 执行前收口表单里的数字字段（#635）：输入过程中保留的文本（"-"、"1."、"1e3"）在这里定案——
 * 能解析为有限数字（整数字段须为整数）就提交数字，否则整体阻止执行并返回出错字段。
 * 字段不存在或本就是非字符串值时不动（缺字段由引擎报错）。
 */
export function normalizeNumberFields(values: FormValues, parameters: readonly NumberFieldSchema[]): NumberNormalization {
  let next = values;
  const invalid: Array<{ id: string; label: string }> = [];
  for (const slot of parameters.flatMap(paramSlots)) {
    const raw = slot.read(next);
    if (typeof raw !== 'string') continue;
    const parsed = parseNumberText(raw, slot.integer);
    if (parsed === null) invalid.push({ id: slot.id, label: slot.label });
    else next = slot.write(next, parsed);
  }
  return invalid.length > 0 ? { ok: false, invalid } : { ok: true, values: next };
}
