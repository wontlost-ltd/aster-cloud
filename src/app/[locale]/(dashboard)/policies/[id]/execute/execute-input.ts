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

/**
 * 表单模式展示不了当前输入时的提示键（policies.execute 命名空间，#634）：
 * 不可解析 → invalidJson；合法但不是对象（数组、字符串、数字、null）→ nonObjectInputInForm
 * （原样提交，不是错误）。
 */
export function formUnavailableKey(input: string): 'invalidJson' | 'nonObjectInputInForm' {
  return parseJsonInput(input).ok ? 'nonObjectInputInForm' : 'invalidJson';
}

/** 执行接口的稳定错误码 → policies.execute 下的文案键（#634、#638）；歧义另有带参数的文案。 */
export const EXECUTE_ERROR_KEYS: Readonly<Record<string, string>> = {
  execution_failed: 'engineErrorDetail',
  invalid_input_object: 'invalidInputObject',
  input_type_extraction_failed: 'inputTypeExtractionFailed',
  entry_rule_required: 'entryRuleRequired',
};

/** 执行接口错误体里与带参数文案相关的字段。 */
export interface ExecuteErrorData {
  code?: unknown;
  field?: unknown;
  policyField?: unknown;
  candidates?: unknown;
}

type Translate = (key: string, values?: Record<string, string>) => string;

/**
 * 需要带参数的执行错误文案（policies.execute 命名空间）：
 * - ambiguous_input_field：写法撞名（带候选）或同一字段写了两次，按策略语言名提示；
 * - missing_input_field：输入缺少规则读取的字段，显示策略语言写法的路径（policyField，缺省回退规范名 field）。
 * 其它错误码（或缺必要字段）返回 null，由调用方按 EXECUTE_ERROR_KEYS / 服务端说明处理。
 */
export function parameterizedExecuteError(data: ExecuteErrorData, t: Translate): string | null {
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const field = text(data.policyField) || text(data.field);
  if (data.code === 'missing_input_field') {
    return field ? t('missingInputField', { field }) : null;
  }
  if (data.code !== 'ambiguous_input_field') return null;
  return Array.isArray(data.candidates)
    ? t('ambiguousInputSpelling', { field, candidates: data.candidates.join(', ') })
    : t('ambiguousInputField', { field });
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

/** 运行时枚举值对象（`{_enum, value, variant}`）的成员名；不是枚举值对象时返回 undefined。 */
function enumMember(value: unknown): string | undefined {
  if (!isPlainObject(value) || typeof value._enum !== 'string') return undefined;
  const member = value.variant ?? value.value;
  return typeof member === 'string' ? member : undefined;
}

/** 把结果里（含结构 / 列表内嵌套的）运行时枚举值对象替换为成员名，其余原样。 */
export function displayResultValue(value: unknown): unknown {
  const member = enumMember(value);
  if (member !== undefined) return member;
  if (Array.isArray(value)) return value.map(displayResultValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, displayResultValue(child)]));
}

/**
 * 执行结果的展示文本（#633）：字符串原样；枚举值对象只显示成员名；结构 / 列表格式化为 JSON，
 * 其中嵌套的枚举值对象同样显示为成员名（调用方传入已本地化的结果时即为策略语言的成员名）。
 */
export function formatResultValue(value: unknown): string {
  const display = displayResultValue(value);
  return typeof display === 'string' ? display : JSON.stringify(display, null, 2);
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
