import { describe, expect, it } from 'vitest';
import { selectLspFeatures } from '@/lib/lsp-features';

const ALL = {
  hoverProvider: true, definitionProvider: true, referencesProvider: true, documentSymbolProvider: true,
  signatureHelpProvider: {}, codeActionProvider: {}, renameProvider: { prepareProvider: true },
  documentFormattingProvider: true, documentHighlightProvider: true,
  completionProvider: { triggerCharacters: ['.'] },
};

describe('selectLspFeatures', () => {
  it('★旧服务端（无 experimental 标志）+ en：不注册引用 / 重命名（实测一个报错、一个恒空）', () => {
    const f = selectLspFeatures('en-US', ALL);
    expect(f.hover && f.definition && f.documentSymbol).toBe(true);
    expect(f.references).toBe(false);
    expect(f.rename).toBe(false);
  });

  it('★旧服务端 + zh：基于解析的功能全部不注册（服务端对 zh 文档恒抛错）', () => {
    const f = selectLspFeatures('zh-CN', ALL);
    expect(Object.values(f).every((v) => v === false)).toBe(true);
  });

  it('新服务端（三个标志）+ zh：全部可用', () => {
    const f = selectLspFeatures('zh-CN', {
      ...ALL,
      experimental: { aster: { localizedParsing: true, openDocumentNavigation: true, canonicalPreview: true } },
    });
    expect(Object.values(f).every((v) => v === true)).toBe(true);
  });

  // ADR 0058 §8.2：服务端在 experimental.aster.canonicalPreview 中声明，客户端按能力探测
  it('canonicalPreview 只随服务端标志开启', () => {
    const flags = { localizedParsing: true, openDocumentNavigation: true };
    expect(selectLspFeatures('de-DE', { ...ALL, experimental: { aster: { ...flags, canonicalPreview: true } } }).canonicalPreview).toBe(true);
    expect(selectLspFeatures('de-DE', { ...ALL, experimental: { aster: flags } }).canonicalPreview).toBe(false);
    expect(selectLspFeatures('de-DE', { ...ALL, experimental: { aster: { ...flags, canonicalPreview: false } } }).canonicalPreview).toBe(false);
    expect(selectLspFeatures('en-US', ALL).canonicalPreview).toBe(false);
  });

  it('文档不可解析时即使声明 canonicalPreview 也不启用（旧服务端 + zh）', () => {
    expect(selectLspFeatures('zh-CN', { ...ALL, experimental: { aster: { canonicalPreview: true } } }).canonicalPreview).toBe(false);
  });

  it('声明 completionProvider 且可解析时启用上下文补全', () => {
    expect(selectLspFeatures('de-DE', ALL).completion).toBe(true);
    expect(selectLspFeatures('en-US', { ...ALL, completionProvider: undefined }).completion).toBe(false);
  });

  it('服务端未声明的能力不注册', () => {
    const f = selectLspFeatures('en-US', { hoverProvider: true, experimental: { aster: { localizedParsing: true, openDocumentNavigation: true } } });
    expect(f.hover).toBe(true);
    expect(f.definition || f.rename || f.references).toBe(false);
  });

  it('★旧服务端 + de：基于解析的功能可用（实测 1.0.32 可解析 de，含变音标识符），引用/重命名仍不注册', () => {
    const f = selectLspFeatures('de-DE', ALL);
    expect(f.hover && f.definition && f.documentSymbol && f.documentHighlight).toBe(true);
    expect(f.references || f.rename).toBe(false);
  });

  it('旧服务端 + hi：未实测，不注册', () => {
    expect(Object.values(selectLspFeatures('hi-IN', ALL)).every((v) => v === false)).toBe(true);
  });
});

