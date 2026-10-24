import type { FieldInfo, ParameterInfo } from '@aster-cloud/aster-lang-ts/browser';

const DEFINE_PATTERN = /\bDefine\s+([A-Z][\w]*)\s+has\s+([\s\S]*?)(?:\.|\n(?=\s*(?:Rule|Define|Module|Profile)\b))/g;

/** 为未标注参数类型的输入，根据同名 Define 补出结构化字段。 */
export function inferParameterStructs(parameters: ParameterInfo[], source: string): ParameterInfo[] {
  const definitions = new Map<string, FieldInfo[]>();
  for (const match of source.matchAll(DEFINE_PATTERN)) {
    const fields = match[2]
      .split(/[\n,]+/)
      .map((part) => part.trim().replace(/\.$/, ''))
      .map((part) => part.match(/^([a-zA-Z_]\w*)(?:\s+as\s+(\w+))?$/i))
      .filter((field): field is RegExpMatchArray => Boolean(field))
      .map((field) => {
        const type = field[2] ?? 'Text';
        const normalized = type.toLowerCase();
        return {
          name: field[1],
          type,
          typeKind: 'primitive' as const,
          // 未标注类型时给空文本；Int/Bool 用安全的中性默认值。
          ...(normalized === 'int' || normalized === 'integer' ? { type: 'Int' } : {}),
        };
      });
    if (fields.length) definitions.set(match[1], fields);
  }

  return parameters.map((parameter) => {
    if (parameter.typeKind !== 'unknown' && parameter.typeKind !== 'primitive') return parameter;
    const structName = `${parameter.name[0]?.toUpperCase() ?? ''}${parameter.name.slice(1)}`;
    const fields = definitions.get(structName);
    if (!fields) return parameter;
    return { ...parameter, type: structName, typeKind: 'struct', fields };
  });
}

/** 对推断字段生成用户可直接填写的中性默认样例。 */
export function inferredFieldDefault(field: Pick<FieldInfo, 'type'>): string | number | boolean {
  const type = field.type.toLowerCase();
  if (type === 'bool' || type === 'boolean') return false;
  if (type === 'int' || type === 'integer' || type === 'float' || type === 'decimal' || type === 'number') return 0;
  return '';
}
