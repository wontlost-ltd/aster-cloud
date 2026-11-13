// 浏览器侧编译结果 → 编辑器模块摘要（StatusBar / SidePanel 决策页消费）。
// Core Module = { kind:'Module', name, profile?, decls:[{kind:'Func'|'Data'|'Enum'|'Import', name}] }；
// profile 为模块声明的治理档案 id（ADR 0046），已安装的 aster-lang-ts 尚未产出该字段时摘要不含此键。
// inputRefs 取自 Func.inputRefs（ADR 0046 §11 D2/D4，ts 1.5.0 起只在档案模块返回 Verdict 的规则上写入）；
// 编辑器读浏览器 Core IR 而不调 aster-api /compile（ADR 0046 §11.7 裁定 1），运行期由 aster-api 用 Java 分析器重算。

export interface EditorCompileModuleSummary {
  name: string;
  functions: string[];
  types: string[];
  /** 模块声明的治理档案 id；未声明或编译器不支持时缺省。 */
  profile?: string;
  /** 规则名 → 对第一个参数读取的引擎路径（原样）；"" 为整个参数，["*"] 为无法静态确定。无任何规则带该字段时缺省。 */
  inputRefs?: Record<string, readonly string[]>;
}

interface DeclLike { kind?: string; name?: string; inputRefs?: unknown }

interface CoreModuleLike {
  name?: string | null;
  profile?: string | null;
  decls?: ReadonlyArray<DeclLike>;
}

const declNames = (decls: ReadonlyArray<DeclLike>, kinds: readonly string[]) =>
  decls.filter((d) => kinds.includes(d.kind ?? '')).map((d) => d.name ?? '').filter(Boolean);

const funcInputRefs = (decls: ReadonlyArray<DeclLike>): Record<string, readonly string[]> =>
  Object.fromEntries(
    decls
      .filter((d) => d.kind === 'Func' && d.name && Array.isArray(d.inputRefs))
      .map((d) => [d.name!, d.inputRefs as readonly string[]]),
  );

/** 仅当编译成功且 Core IR 带模块名时可得摘要，否则 undefined。 */
export function summarizeCoreModule(
  compileResult: { success?: boolean; core?: unknown } | null | undefined,
): EditorCompileModuleSummary | undefined {
  const core = compileResult?.core as CoreModuleLike | undefined;
  if (!compileResult?.success || !core?.name) return undefined;
  const decls = core.decls ?? [];
  const inputRefs = funcInputRefs(decls);
  return {
    name: core.name,
    functions: declNames(decls, ['Func']),
    types: declNames(decls, ['Data', 'Enum']),
    ...(typeof core.profile === 'string' && core.profile !== '' ? { profile: core.profile } : {}),
    ...(Object.keys(inputRefs).length > 0 ? { inputRefs } : {}),
  };
}
