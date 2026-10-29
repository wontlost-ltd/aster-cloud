// ADR 0051：名称解析诊断（E8xx 错误 / W8xx 警告）只出现在 resolutionDiagnostics，
// 编辑器 hook 必须把它们并入 diagnostics 并作为 Monaco marker 下发，否则作者看不到任何标记。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { TypecheckDiagnostic } from '@aster-cloud/aster-lang-ts/browser';

const engine = vi.hoisted(() => ({ override: null as null | ((...args: unknown[]) => unknown) }));

vi.mock('@aster-cloud/aster-lang-ts/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aster-cloud/aster-lang-ts/browser')>();
  return {
    ...actual,
    // 默认走真实引擎；个别用例用 engine.override 注入引擎当前难以构造的诊断（W8xx）。
    compileAndTypecheck: (...args: Parameters<typeof actual.compileAndTypecheck>) =>
      engine.override ? engine.override(...args) : actual.compileAndTypecheck(...args),
  };
});

import { useAsterCompiler, collectCompileDiagnostics } from '@/hooks/useAsterCompiler';

/** 引擎真实报 E802：裸名 threshold 既非声明也非词汇条目。 */
const UNRESOLVED_SOURCE = `Module demo.

Define Applicant has
  creditScore as Int.

Rule check given applicant as Applicant, produce Bool:
  Return applicant.creditScore at least threshold.
`;

const W801: TypecheckDiagnostic = {
  severity: 'warning',
  code: 'W801' as TypecheckDiagnostic['code'],
  message: "Resolved 'hoch' without an expected type",
  span: { start: { line: 3, col: 5 }, end: { line: 3, col: 9 } },
};

function fakeEditorAndMonaco(source: string) {
  const setModelMarkers = vi.fn();
  const model = {
    getValue: () => source,
    getLineMaxColumn: () => 80,
    onDidChangeContent: () => ({ dispose: () => {} }),
  };
  const editor = { getModel: () => model };
  const monaco = {
    editor: { setModelMarkers },
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
  };
  return {
    editor: editor as unknown as import('monaco-editor').editor.IStandaloneCodeEditor,
    monaco: monaco as unknown as typeof import('monaco-editor'),
    setModelMarkers,
  };
}

afterEach(() => {
  engine.override = null;
  cleanup();
});

describe('useAsterCompiler：名称解析诊断', () => {
  it('E802（真实引擎）进入 diagnostics 并标成 Error marker', () => {
    const { editor, monaco, setModelMarkers } = fakeEditorAndMonaco(UNRESOLVED_SOURCE);
    const { result } = renderHook(() => useAsterCompiler({ editor, monaco, locale: 'en-US' }));

    const e802 = result.current.diagnostics.find((d) => d.code === 'E802');
    expect(e802, JSON.stringify(result.current.diagnostics)).toBeDefined();
    expect(e802!.severity).toBe('error');
    expect(e802!.span).toEqual({ start: { line: 7, col: 41 }, end: { line: 7, col: 50 } });
    expect(result.current.errors).toContain(e802!.message);

    const markers = setModelMarkers.mock.calls.at(-1)![2] as Array<Record<string, unknown>>;
    expect(markers).toContainEqual(
      expect.objectContaining({ code: 'E802', severity: 8, startLineNumber: 7, startColumn: 41, endColumn: 50 }),
    );
  });

  it('compileSource 同样收集 E802', () => {
    const { editor, monaco } = fakeEditorAndMonaco(UNRESOLVED_SOURCE);
    const { result } = renderHook(() =>
      useAsterCompiler({ editor, monaco, locale: 'en-US', enableValidation: false }),
    );
    expect(result.current.diagnostics).toEqual([]);
    act(() => {
      result.current.compileSource();
    });
    expect(result.current.diagnostics.map((d) => d.code)).toContain('E802');
  });

  it('W8xx 警告（编译成功时）进入 diagnostics 并标成 Warning marker', () => {
    engine.override = () => ({ success: true, typeErrors: [], resolutionDiagnostics: [W801] });
    const { editor, monaco, setModelMarkers } = fakeEditorAndMonaco('Module demo.\n');
    const { result } = renderHook(() => useAsterCompiler({ editor, monaco, locale: 'en-US' }));

    expect(result.current.diagnostics).toEqual([W801]);
    const markers = setModelMarkers.mock.calls.at(-1)![2] as Array<Record<string, unknown>>;
    expect(markers).toEqual([
      expect.objectContaining({ code: 'W801', severity: 4, startLineNumber: 3, startColumn: 5, endColumn: 9 }),
    ]);
  });
});

describe('collectCompileDiagnostics', () => {
  it('按 解析 → 名称解析 → 降级 → 类型 的顺序汇总', () => {
    const typeErr: TypecheckDiagnostic = { severity: 'error', code: 'E001' as TypecheckDiagnostic['code'], message: 't' };
    const out = collectCompileDiagnostics({
      success: false,
      parseErrors: [{ message: 'p' } as never],
      resolutionDiagnostics: [W801],
      loweringErrors: ['l'],
      typeErrors: [typeErr],
    });
    expect(out.map((d) => d.message)).toEqual(['p', W801.message, 'l', 't']);
  });

  it('全部缺省时返回空数组', () => {
    expect(collectCompileDiagnostics({ success: true })).toEqual([]);
  });
});
