/**
 * 按服务端**实际能力**决定编辑器注册哪些 LSP 功能（纯函数，便于测试）。
 *
 * ★原则：只注册对当前服务端真正可用的功能——宁可没有，也不要「弹出重命名框却什么都不改」。
 *
 * 实测（aster-lang-ts 1.0.32，即当前生产镜像）：
 *   - en-US：hover / 跳转定义 / 文档符号 / 高亮 / 签名帮助 / 代码操作 / 格式化 可用；
 *     引用报 `require is not defined`，重命名在 prepareRename 成功后恒回空 changes。
 *   - zh-CN / de-DE：所有基于解析的请求都抛 "Unexpected character"（服务端 lex 漏传 lexicon）。
 * 修复后的服务端在 initialize 返回 `experimental.aster` 标志（aster-lang-ts#219）：
 *   - localizedParsing      —— 非英文文档可正常解析
 *   - openDocumentNavigation —— 引用 / 重命名读打开中的内存文本（inmemory 文档可用）
 */

export interface LspServerCapabilities {
  hoverProvider?: unknown;
  definitionProvider?: unknown;
  referencesProvider?: unknown;
  documentSymbolProvider?: unknown;
  signatureHelpProvider?: unknown;
  codeActionProvider?: unknown;
  renameProvider?: unknown;
  documentFormattingProvider?: unknown;
  documentHighlightProvider?: unknown;
  experimental?: { aster?: { localizedParsing?: boolean; openDocumentNavigation?: boolean } };
}

export interface LspFeatures {
  hover: boolean;
  definition: boolean;
  references: boolean;
  documentSymbol: boolean;
  signatureHelp: boolean;
  codeAction: boolean;
  rename: boolean;
  formatting: boolean;
  documentHighlight: boolean;
}

export function selectLspFeatures(locale: string, caps: LspServerCapabilities | null | undefined): LspFeatures {
  const c = caps ?? {};
  const flags = c.experimental?.aster ?? {};
  const parses = locale === 'en-US' || flags.localizedParsing === true;
  const openDocs = parses && flags.openDocumentNavigation === true;
  const has = (v: unknown) => Boolean(v);
  return {
    hover: parses && has(c.hoverProvider),
    definition: parses && has(c.definitionProvider),
    documentSymbol: parses && has(c.documentSymbolProvider),
    signatureHelp: parses && has(c.signatureHelpProvider),
    codeAction: parses && has(c.codeActionProvider),
    formatting: parses && has(c.documentFormattingProvider),
    documentHighlight: parses && has(c.documentHighlightProvider),
    references: openDocs && has(c.referencesProvider),
    rename: openDocs && has(c.renameProvider),
  };
}
