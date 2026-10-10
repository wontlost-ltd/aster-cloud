// 浏览器侧编译结果 → 编辑器模块摘要（StatusBar / SidePanel 决策页消费）。
// Core Module = { kind:'Module', name, profile?, decls:[{kind:'Func'|'Data'|'Enum'|'Import', name}] }；
// profile 为模块声明的治理档案 id（ADR 0046），已安装的 aster-lang-ts 尚未产出该字段时摘要不含此键。

export interface EditorCompileModuleSummary {
  name: string;
  functions: string[];
  types: string[];
  /** 模块声明的治理档案 id；未声明或编译器不支持时缺省。 */
  profile?: string;
}

interface CoreModuleLike {
  name?: string | null;
  profile?: string | null;
  decls?: ReadonlyArray<{ kind?: string; name?: string }>;
}

const declNames = (decls: ReadonlyArray<{ kind?: string; name?: string }>, kinds: readonly string[]) =>
  decls.filter((d) => kinds.includes(d.kind ?? '')).map((d) => d.name ?? '').filter(Boolean);

/** 仅当编译成功且 Core IR 带模块名时可得摘要，否则 undefined。 */
export function summarizeCoreModule(
  compileResult: { success?: boolean; core?: unknown } | null | undefined,
): EditorCompileModuleSummary | undefined {
  const core = compileResult?.core as CoreModuleLike | undefined;
  if (!compileResult?.success || !core?.name) return undefined;
  const decls = core.decls ?? [];
  return {
    name: core.name,
    functions: declNames(decls, ['Func']),
    types: declNames(decls, ['Data', 'Enum']),
    ...(typeof core.profile === 'string' && core.profile !== '' ? { profile: core.profile } : {}),
  };
}
