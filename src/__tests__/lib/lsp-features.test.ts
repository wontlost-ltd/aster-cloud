import { describe, expect, it } from 'vitest';
import { selectLspFeatures } from '@/lib/lsp-features';

const ALL = {
  hoverProvider: true, definitionProvider: true, referencesProvider: true, documentSymbolProvider: true,
  signatureHelpProvider: {}, codeActionProvider: {}, renameProvider: { prepareProvider: true },
  documentFormattingProvider: true, documentHighlightProvider: true,
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

  it('新服务端（两个标志）+ zh：全部可用', () => {
    const f = selectLspFeatures('zh-CN', { ...ALL, experimental: { aster: { localizedParsing: true, openDocumentNavigation: true } } });
    expect(Object.values(f).every((v) => v === true)).toBe(true);
  });

  it('服务端未声明的能力不注册', () => {
    const f = selectLspFeatures('en-US', { hoverProvider: true, experimental: { aster: { localizedParsing: true, openDocumentNavigation: true } } });
    expect(f.hover).toBe(true);
    expect(f.definition || f.rename || f.references).toBe(false);
  });
});
