'use client';

/**
 * 编译诊断的类型契约（供 StatusBar / SidePanel 消费）。
 *
 * 历史上此文件导出一个 `useCompile` hook（parse-only，`validateSyntaxWithSpan`），与
 * MonacoPolicyEditor 内部的 `useAsterCompiler`（完整 parse+typecheck）**并存**——同一 buffer
 * 每次按键解析两遍、两份 Problems 面板、两份红波浪线，且两条管线的 aliasSet 会不同步
 * （编辑器 footer 误报解析错误的根因）。现已收敛为单一真相源：MonacoPolicyEditor 经
 * `onCompileChange` 上抛诊断，父层 policy-form 直接消费。此文件只保留类型定义，形状与
 * MonacoPolicyEditor 的 `EditorCompile*` 一致（结构兼容），避免下游 import 路径大改。
 */

export interface CompileDiagnostic {
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  code?: string;
}

export interface CompileModuleSummary {
  name: string;
  functions: string[];
  types: string[];
  /** 模块声明的治理档案 id（ADR 0046）；未声明时缺省。 */
  profile?: string;
}

export type CompileState = 'idle' | 'pending' | 'ok' | 'error';

export interface UseCompileResult {
  state: CompileState;
  diagnostics: CompileDiagnostic[];
  module?: CompileModuleSummary;
  /** 保留在结果类型上以兼容既有消费者；浏览器编译路径永不设置。 */
  transportError?: string;
}
