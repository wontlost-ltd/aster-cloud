// #708：hi 策略在编辑器里按 hi-IN 词法编译（此前被映射成 en-US，句末「।」报 Unexpected character）。
// 样本取自引擎 hi-IN 词法表的端到端编译用例。编辑器与保存入口对同一 locale 规范成同一标签，
// 服务端编译门（seed-compile-gate，与编辑器同一份引擎）对样本的 error 结论一致。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { HI_IN } from '@aster-cloud/aster-lang-ts/browser';
import { useAsterCompiler, LEXICON_MAP } from '@/hooks/useAsterCompiler';
import { parseCompileLocale, toEditorCnlLocale } from '@/lib/cnl-locale';
import { seedCompileProblems } from '@/lib/seed-compile-gate';

const HI_SAMPLES = {
  pricing: [
    'मॉड्यूल pricing।',
    '',
    'नियम discountedPrice दिया गया amount रूप में पूर्णांक, उत्पन्न पूर्णांक:',
    '  यदि amount से अधिक 100',
    '    लौटाएं amount गुणा 80 भाग 100।',
    '  लौटाएं amount।',
  ].join('\n'),
  loan: [
    'मॉड्यूल loan।',
    '',
    'परिभाषित Applicant रखता है creditScore रूप में पूर्णांक, income रूप में पूर्णांक।',
    '',
    'नियम approve दिया गया a रूप में Applicant, उत्पन्न बूलियन:',
    '  यदि a.creditScore से अधिक 700',
    '    लौटाएं सत्य।',
    '  लौटाएं असत्य।',
  ].join('\n'),
  calc: [
    'मॉड्यूल calc।',
    '',
    'नियम net दिया गया gross रूप में पूर्णांक, tax रूप में पूर्णांक, उत्पन्न पूर्णांक:',
    '  मानें result हो gross घटा tax।',
    '  यदि result से कम 0',
    '    लौटाएं 0।',
    '  लौटाएं result।',
  ].join('\n'),
  // 缺句末「।」：hi 词法下应报缺句号，而不是把「।」当未知字符
  missingTerminator: ['मॉड्यूल calc', '', 'नियम net दिया गया x रूप में पूर्णांक, उत्पन्न पूर्णांक:', '  लौटाएं x।'].join('\n'),
};

function fakeEditorAndMonaco(source: string) {
  const model = { getValue: () => source, getLineMaxColumn: () => 80, onDidChangeContent: () => ({ dispose: () => {} }) };
  return {
    editor: { getModel: () => model } as unknown as import('monaco-editor').editor.IStandaloneCodeEditor,
    monaco: {
      editor: { setModelMarkers: vi.fn() },
      MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
    } as unknown as typeof import('monaco-editor'),
  };
}

afterEach(() => cleanup());

describe('useAsterCompiler — hi-IN（#708）', () => {
  it('编辑器语言 hi 规范为 hi-IN，词法表为 HI_IN', () => {
    expect(toEditorCnlLocale('hi')).toBe('hi-IN');
    expect(LEXICON_MAP[toEditorCnlLocale('hi')].id).toBe(HI_IN.id);
  });

  it.each(['pricing', 'loan', 'calc'] as const)('hi 样本 %s 无诊断', (name) => {
    const { editor, monaco } = fakeEditorAndMonaco(HI_SAMPLES[name]);
    const { result } = renderHook(() => useAsterCompiler({ editor, monaco, locale: 'hi-IN' }));
    expect(result.current.diagnostics).toEqual([]);
  });

  it('缺句末「।」：报缺句号，不再报 Unexpected character', () => {
    const { editor, monaco } = fakeEditorAndMonaco(HI_SAMPLES.missingTerminator);
    const { result } = renderHook(() => useAsterCompiler({ editor, monaco, locale: 'hi-IN' }));
    expect(result.current.diagnostics.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.current.diagnostics)).not.toMatch(/Unexpected character/);
  });

  it.each(['hi', 'hi-IN', 'HI-in', 'zh', 'de', 'en-US'])('编辑器与保存入口对 locale=%s 规范成同一标签', (raw) => {
    expect(parseCompileLocale(raw)).toEqual({ ok: true, locale: toEditorCnlLocale(raw) });
  });

  it.each(Object.keys(HI_SAMPLES) as Array<keyof typeof HI_SAMPLES>)(
    '编辑器与服务端编译门对 %s 的 error 级诊断一致',
    async (name) => {
      const source = HI_SAMPLES[name];
      const { editor, monaco } = fakeEditorAndMonaco(source);
      const { result } = renderHook(() => useAsterCompiler({ editor, monaco, locale: 'hi-IN' }));
      const editorErrors = result.current.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
      const serverErrors = (await seedCompileProblems(source, 'hi-IN')).map((p) => p.code);
      expect(editorErrors).toEqual(serverErrors);
    },
  );
});
