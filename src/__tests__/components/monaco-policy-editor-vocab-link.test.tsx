/**
 * 编辑器问题面板：词汇歧义诊断（E804）带出写法并链接到按该写法过滤的词汇页（ADR 0051 §1）。
 * 2026-10-30 生产复测 A4：问题面板与诊断项里都没有指向 /domain-vocabularies 的链接。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const fakeMonaco = {
  languages: {
    register: vi.fn(),
    setMonarchTokensProvider: vi.fn(),
    setLanguageConfiguration: vi.fn(),
    registerCompletionItemProvider: vi.fn(() => ({ dispose: vi.fn() })),
    registerInlineCompletionsProvider: vi.fn(() => ({ dispose: vi.fn() })),
    registerHoverProvider: vi.fn(() => ({ dispose: vi.fn() })),
    CompletionItemKind: { Keyword: 17, Module: 8, Variable: 4, Function: 1, Snippet: 27 },
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
  },
  editor: { defineTheme: vi.fn(), setTheme: vi.fn(), setModelMarkers: vi.fn(), getModelMarkers: vi.fn(() => []) },
  MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
  KeyMod: { CtrlCmd: 2048, Shift: 1024 },
  KeyCode: { KeyG: 37, KeyE: 35 },
  Uri: { parse: (s: string) => ({ toString: () => s }) },
};
const fakeModel = {
  getValue: () => '', getVersionId: () => 1, uri: { toString: () => 'inmemory://policy/default.aster' },
  onDidChangeContent: () => ({ dispose: vi.fn() }), deltaDecorations: () => [], getLineCount: () => 1,
};
const fakeEditor = {
  getModel: () => fakeModel, getValue: () => '', onDidChangeModelContent: () => ({ dispose: vi.fn() }),
  onDidChangeCursorPosition: () => ({ dispose: vi.fn() }), addCommand: vi.fn(), addAction: vi.fn(),
  getPosition: () => ({ lineNumber: 1, column: 1 }), getSelection: () => null, deltaDecorations: () => [],
  createDecorationsCollection: () => ({ set: vi.fn(), clear: vi.fn() }), updateOptions: vi.fn(), layout: vi.fn(),
};

vi.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: ({ onMount }: { onMount?: (e: unknown, m: unknown) => void }) => {
    onMount?.(fakeEditor, fakeMonaco);
    return null;
  },
}));
vi.mock('@/hooks/useAsterLSP', () => ({
  useAsterLSP: () => ({ connected: false, connecting: false, error: null, connect: vi.fn(), disconnect: vi.fn(), reconnect: vi.fn() }),
}));

const E804 = {
  severity: 'error',
  code: 'E804',
  message: "Name 'Hoch' in MEMBER_REF position is ambiguous between: High (Hoch), high (hoch)",
  data: { written: 'Hoch', role: 'MEMBER_REF', candidates: 'High (Hoch), high (hoch)' },
  span: { start: { line: 9, col: 14 }, end: { line: 9, col: 18 } },
};
const E003 = { severity: 'error', code: 'E003', message: "Undefined variable 'x'", span: { start: { line: 2, col: 1 }, end: { line: 2, col: 2 } } };
vi.mock('@/hooks/useAsterCompiler', () => ({
  useAsterCompiler: () => ({ diagnostics: [E804, E003], compileResult: null }),
}));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: { user: { id: 't' } }, status: 'authenticated' }) }));
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('next-intl', () => ({
  useTranslations: () => (k: string, v?: Record<string, string>) => (v?.term ? `${k}:${v.term}` : k),
  useLocale: () => 'de',
}));
vi.mock('@/hooks/useUserVocabularyRegistration', () => ({
  useUserVocabularyRegistration: () => ({ vocabulary: undefined, domain: undefined, registrationKey: '' }),
}));
vi.mock('@/hooks/useDomainVocabularyInvalidate', () => ({ useDomainVocabularyInvalidate: () => 0 }));
vi.mock('@/hooks/useAsterModuleCatalog', () => ({ useAsterModuleCatalog: () => ({ modules: [], error: null }) }));
vi.mock('@/components/policy/use-entry-rule-decorations', () => ({ useEntryRuleDecorations: () => undefined }));

import { MonacoPolicyEditor } from '@/components/policy/monaco-policy-editor';

describe('编辑器问题面板：词汇诊断链接', () => {
  it('★E804 条目下有「在领域词汇中查看 Hoch」链接，指向按写法过滤的词汇页；非词汇诊断没有', () => {
    render(<MonacoPolicyEditor value="Modul m." onChange={() => {}} locale="de" />);
    fireEvent.click(screen.getByRole('button', { name: 'viewProblems' }));

    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveTextContent('openVocabularyTerm:Hoch');
    expect(links[0]).toHaveAttribute('href', '/de/domain-vocabularies?q=Hoch');
  });
});
