/**
 * useAsterLSP Hook
 *
 * Provides Language Server Protocol integration for the Aster CNL editor.
 * Manages WebSocket connection to the LSP server and Monaco language client.
 *
 * Features:
 * - Real-time diagnostics (parse errors, type errors)
 * - Code completion
 * - Hover information
 * - Go to definition
 * - Find references
 * - Document symbols
 * - Signature help
 * - Code actions
 * - Rename symbol
 * - Document formatting
 */

'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import type { editor, languages, IDisposable, Position } from 'monaco-editor';
import { buildLspInitOptions, shouldApplyDiagnostics } from '@/lib/lsp-init-options';

export type CNLLocale = 'en-US' | 'zh-CN' | 'de-DE';

export interface UseAsterLSPOptions {
  /** Monaco editor instance */
  editor: editor.IStandaloneCodeEditor | null;
  /** Document URI for LSP */
  documentUri: string;
  /** CNL language locale */
  locale?: CNLLocale;
  /**
   * 租户标识符。与 `domainVocabularies` **必须成对提供**才生效：
   * 服务端（aster-lang-ts server.ts:209）要求 tenantId 存在且
   * domainVocabularies 是数组，缺一则整块忽略。
   */
  tenantId?: string;
  /**
   * 用户自定义领域词汇。服务端按 (tenantId, domain, locale) 三元组查询，
   * 且 `currentDomain` 取自本数组**第 0 项**——故顺序有意义，
   * 当前生效的 domain 必须排在首位。
   */
  domainVocabularies?: readonly unknown[];
  /** Auto-connect on mount */
  autoConnect?: boolean;
  /** Reconnect on disconnect */
  autoReconnect?: boolean;
  /** Reconnect delay in ms */
  reconnectDelay?: number;
  /** Maximum reconnect attempts (0 = unlimited) */
  maxReconnectAttempts?: number;
  /** Suppress console errors for connection failures */
  suppressErrors?: boolean;
  /**
   * 丢弃服务端推送的诊断，不往 Monaco 写 marker。
   *
   * ★调用方若已有另一条诊断管线，**必须**打开这个开关：Monaco 的 marker
   *   按 owner 分桶，`setModelMarkers` 只替换同名 owner 那一桶。本 hook 用
   *   `'aster-lsp'`、useAsterCompiler 用 `'aster-compiler'` —— owner 不同
   *   恰恰保证**两套同时渲染**，用户会看到每个错误两条红波浪线、
   *   Problems 面板双份条目（且两边行列基准还不同：这里 +1、那边直接透传）。
   *
   *   而这条路径必然触发：本 hook 在 initialize 时声明了
   *   `publishDiagnostics` 能力，并会发 didOpen / didChange。
   */
  suppressDiagnostics?: boolean;
}

export interface UseAsterLSPResult {
  /** Whether connected to LSP server */
  connected: boolean;
  /** Whether currently connecting */
  connecting: boolean;
  /** Connection error message */
  error: string | null;
  /** Manually connect to LSP */
  connect: () => Promise<void>;
  /** Manually disconnect from LSP */
  disconnect: () => void;
  /** Reconnect to LSP */
  reconnect: () => Promise<void>;
}

interface LSPMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// LSP types
interface LSPPosition {
  line: number;
  character: number;
}

interface LSPRange {
  start: LSPPosition;
  end: LSPPosition;
}

interface LSPLocation {
  uri: string;
  range: LSPRange;
}

interface LSPTextEdit {
  range: LSPRange;
  newText: string;
}

interface LSPHover {
  contents: string | { kind: string; value: string } | Array<string | { kind: string; value: string }>;
  range?: LSPRange;
}

interface LSPSignatureHelp {
  signatures: Array<{
    label: string;
    documentation?: string | { kind: string; value: string };
    parameters?: Array<{
      label: string | [number, number];
      documentation?: string | { kind: string; value: string };
    }>;
  }>;
  activeSignature?: number;
  activeParameter?: number;
}

interface LSPSymbolInformation {
  name: string;
  kind: number;
  location: LSPLocation;
  containerName?: string;
}

interface LSPDocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: LSPRange;
  selectionRange: LSPRange;
  children?: LSPDocumentSymbol[];
}

interface LSPCodeAction {
  title: string;
  kind?: string;
  diagnostics?: Array<{ range: LSPRange; message: string; severity?: number }>;
  isPreferred?: boolean;
  edit?: {
    changes?: Record<string, LSPTextEdit[]>;
    documentChanges?: Array<{ textDocument: { uri: string }; edits: LSPTextEdit[] }>;
  };
  command?: { title: string; command: string; arguments?: unknown[] };
}

interface LSPWorkspaceEdit {
  changes?: Record<string, LSPTextEdit[]>;
  documentChanges?: Array<{ textDocument: { uri: string }; edits: LSPTextEdit[] }>;
}

/**
 * Convert LSP position to Monaco position
 */
/**
 * Convert Monaco position to LSP position
 */
function monacoPositionToLsp(pos: { lineNumber: number; column: number }): LSPPosition {
  return { line: pos.lineNumber - 1, character: pos.column - 1 };
}

/**
 * Convert LSP range to Monaco range
 */
function lspRangeToMonaco(range: LSPRange): { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number } {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

/**
 * Hook for integrating Aster CNL Language Server with Monaco editor
 */
export function useAsterLSP({
  editor,
  documentUri,
  locale = 'en-US',
  tenantId,
  domainVocabularies,
  suppressDiagnostics = false,
  autoConnect = true,
  autoReconnect = true,
  reconnectDelay = 3000,
  maxReconnectAttempts = 3,
  suppressErrors = true,
}: UseAsterLSPOptions): UseAsterLSPResult {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const requestIdRef = useRef(0);
  const pendingRequestsRef = useRef<Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>>(new Map());
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isDisposedRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const providerDisposablesRef = useRef<IDisposable[]>([]);
  // ref-latch：把最新的 editor/documentUri prop 镜像进 ref，避免各回调里读到
  // 陈旧闭包。属渲染期同步最新 prop 的惯用写法，ref 值不参与本次渲染输出。
  const editorRef = useRef(editor);
  // eslint-disable-next-line react-hooks/refs
  editorRef.current = editor;
  const documentUriRef = useRef(documentUri);
  // eslint-disable-next-line react-hooks/refs
  documentUriRef.current = documentUri;

  /**
   * Get the WebSocket URL for LSP connection
   */
  const getWebSocketUrl = useCallback((): string => {
    if (typeof window === 'undefined') return '';

    const lspHost = process.env.NEXT_PUBLIC_LSP_HOST;
    // LSP WS 网关的 token（#98）。浏览器无法为 WebSocket 设置自定义头，故只能作为
    // query param 附加——这是该协议的固有约束，不是可以简单去掉的实现选择。
    //
    // ★因此这个值**不是密钥，也不能当密钥用**：NEXT_PUBLIC_ 前缀在构建期内联，
    // 任何访客都能在 devtools / 打包产物里读到它，它还会进代理与访问日志。
    // 它能提供的只是「挡住无差别扫描」这种程度的门槛。
    //
    // 结论：LSP 服务端**不得**把它当作唯一鉴权依据。真正的访问控制应放在
    // 网络层（只允许来自应用域的 Origin / 内网可达性 / 反向代理鉴权），
    // 或改用一次性、短时效、由服务端签发并与会话绑定的 ticket。
    // 见审计报告 2026-07-29。
    const lspToken = process.env.NEXT_PUBLIC_LSP_TOKEN;
    const tokenParam = lspToken ? `&token=${encodeURIComponent(lspToken)}` : '';

    if (lspHost) {
      let host = lspHost;
      if (host.startsWith('https://') || host.startsWith('http://')) {
        host = host.replace(/^https?:\/\//, '');
      } else if (host.startsWith('wss://') || host.startsWith('ws://')) {
        host = host.replace(/^wss?:\/\//, '');
      }
      host = host.replace(/\/$/, '');
      const protocol = host.startsWith('localhost') ? 'ws:' : 'wss:';
      return `${protocol}//${host}/lsp?locale=${locale}${tokenParam}`;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/api/lsp?locale=${locale}${tokenParam}`;
  }, [locale]);

  /**
   * Send an LSP request and wait for response
   */
  const sendRequest = useCallback(
    async <T>(method: string, params?: unknown): Promise<T> => {
      return new Promise((resolve, reject) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          reject(new Error('WebSocket not connected'));
          return;
        }

        const id = ++requestIdRef.current;
        const message: LSPMessage = {
          jsonrpc: '2.0',
          id,
          method,
          params,
        };

        pendingRequestsRef.current.set(id, {
          resolve: resolve as (r: unknown) => void,
          reject,
        });

        ws.send(JSON.stringify(message));
      });
    },
    []
  );

  /**
   * Send an LSP notification (no response expected)
   */
  const sendNotification = useCallback((method: string, params?: unknown): void => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn('[LSP] Cannot send notification: not connected');
      return;
    }

    const message: LSPMessage = {
      jsonrpc: '2.0',
      method,
      params,
    };

    ws.send(JSON.stringify(message));
  }, []);

  /**
   * Handle notifications from the LSP server
   */
  const handleServerNotification = useCallback(
    (method: string, params: unknown) => {
      switch (method) {
        case 'textDocument/publishDiagnostics': {
          /* ★调用方自带诊断管线时丢弃这批 —— 否则 Monaco 会同时渲染
           *   'aster-lsp' 与 'aster-compiler' 两套 marker（owner 不同 =
           *   互不覆盖），用户看到的是每个错误两条红波浪线。 */
          if (!shouldApplyDiagnostics(suppressDiagnostics)) break;
          const diagnosticParams = params as {
            uri: string;
            diagnostics: Array<{
              range: LSPRange;
              message: string;
              severity?: number;
            }>;
          };
          console.log('[LSP] Diagnostics received:', diagnosticParams.diagnostics.length);

          const currentEditor = editorRef.current;
          if (currentEditor) {
            const model = currentEditor.getModel();
            if (model) {
              import('monaco-editor').then((monaco) => {
                const markers = diagnosticParams.diagnostics.map((d) => ({
                  severity: d.severity === 1 ? monaco.MarkerSeverity.Error
                    : d.severity === 2 ? monaco.MarkerSeverity.Warning
                    : d.severity === 3 ? monaco.MarkerSeverity.Info
                    : monaco.MarkerSeverity.Hint,
                  message: d.message,
                  startLineNumber: d.range.start.line + 1,
                  startColumn: d.range.start.character + 1,
                  endLineNumber: d.range.end.line + 1,
                  endColumn: d.range.end.character + 1,
                }));
                console.log('[LSP] Setting Monaco markers:', markers.length);
                monaco.editor.setModelMarkers(model, 'aster-lsp', markers);
              });
            }
          }
          break;
        }
        case 'window/logMessage':
        case 'window/showMessage': {
          const msgParams = params as { type: number; message: string };
          const types = ['', 'Error', 'Warning', 'Info', 'Log'];
          console.log(`[LSP ${types[msgParams.type] || 'Message'}]`, msgParams.message);
          break;
        }
        default:
          console.log('[LSP] Notification:', method);
      }
    },
    // suppressDiagnostics 必须进 deps：空数组会让它被首次渲染的值永久捕获，
    // 调用方后来打开开关也不生效（诊断照样双份）。
    [suppressDiagnostics]
  );

  /**
   * Process a single parsed LSP message
   */
  const processMessage = useCallback((message: LSPMessage) => {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = pendingRequestsRef.current.get(message.id as number);
      if (pending) {
        pendingRequestsRef.current.delete(message.id as number);
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }

    if (message.method) {
      handleServerNotification(message.method, message.params);
    }
  }, [handleServerNotification]);

  /**
   * Handle incoming LSP messages
   */
  const handleMessage = useCallback((data: string) => {
    try {
      const message: LSPMessage = JSON.parse(data);
      processMessage(message);
      return;
    } catch {
      // Handle concatenated JSON
    }

    const remaining = data.trim();
    let depth = 0;
    let start = 0;

    for (let i = 0; i < remaining.length; i++) {
      const char = remaining[i];
      if (char === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0) {
          const jsonStr = remaining.slice(start, i + 1);
          try {
            const message: LSPMessage = JSON.parse(jsonStr);
            processMessage(message);
          } catch (e) {
            console.error('[LSP] Failed to parse message segment:', e);
          }
        }
      }
    }
  }, [processMessage]);

  /**
   * Register Monaco language providers for LSP features
   */
  const registerProviders = useCallback(async () => {
    const monaco = await import('monaco-editor');
    const languageId = 'aster-cnl';

    // Dispose existing providers
    providerDisposablesRef.current.forEach(d => d.dispose());
    providerDisposablesRef.current = [];

    // Helper to make LSP requests with proper parameters
    const makeTextDocumentPositionParams = (position: Position) => ({
      textDocument: { uri: documentUriRef.current },
      position: monacoPositionToLsp(position),
    });

    // Hover Provider
    const hoverProvider = monaco.languages.registerHoverProvider(languageId, {
      provideHover: async (model, position): Promise<languages.Hover | null> => {
        try {
          const result = await sendRequest<LSPHover | null>('textDocument/hover', makeTextDocumentPositionParams(position));
          if (!result) return null;

          let contents: { value: string }[];
          if (typeof result.contents === 'string') {
            contents = [{ value: result.contents }];
          } else if (Array.isArray(result.contents)) {
            contents = result.contents.map(c => typeof c === 'string' ? { value: c } : { value: c.value });
          } else {
            contents = [{ value: result.contents.value }];
          }

          return {
            contents,
            range: result.range ? lspRangeToMonaco(result.range) : undefined,
          };
        } catch (e) {
          console.error('[LSP] Hover error:', e);
          return null;
        }
      },
    });
    providerDisposablesRef.current.push(hoverProvider);

    // Definition Provider
    const definitionProvider = monaco.languages.registerDefinitionProvider(languageId, {
      provideDefinition: async (model, position): Promise<languages.Definition | null> => {
        try {
          const result = await sendRequest<LSPLocation | LSPLocation[] | null>('textDocument/definition', makeTextDocumentPositionParams(position));
          if (!result) return null;

          const locations = Array.isArray(result) ? result : [result];
          return locations.map(loc => ({
            uri: monaco.Uri.parse(loc.uri),
            range: lspRangeToMonaco(loc.range),
          }));
        } catch (e) {
          console.error('[LSP] Definition error:', e);
          return null;
        }
      },
    });
    providerDisposablesRef.current.push(definitionProvider);

    // References Provider
    const referencesProvider = monaco.languages.registerReferenceProvider(languageId, {
      provideReferences: async (model, position, context): Promise<languages.Location[] | null> => {
        try {
          const result = await sendRequest<LSPLocation[] | null>('textDocument/references', {
            ...makeTextDocumentPositionParams(position),
            context: { includeDeclaration: context.includeDeclaration },
          });
          if (!result) return null;

          return result.map(loc => ({
            uri: monaco.Uri.parse(loc.uri),
            range: lspRangeToMonaco(loc.range),
          }));
        } catch (e) {
          console.error('[LSP] References error:', e);
          return null;
        }
      },
    });
    providerDisposablesRef.current.push(referencesProvider);

    // Document Symbol Provider
    const documentSymbolProvider = monaco.languages.registerDocumentSymbolProvider(languageId, {
      provideDocumentSymbols: async (_model): Promise<languages.DocumentSymbol[] | null> => {
        try {
          const result = await sendRequest<LSPDocumentSymbol[] | LSPSymbolInformation[] | null>('textDocument/documentSymbol', {
            textDocument: { uri: documentUriRef.current },
          });
          if (!result || result.length === 0) return null;

          // Convert LSP symbols to Monaco symbols
          const convertSymbol = (sym: LSPDocumentSymbol): languages.DocumentSymbol => ({
            name: sym.name,
            detail: sym.detail || '',
            kind: sym.kind as languages.SymbolKind,
            range: lspRangeToMonaco(sym.range),
            selectionRange: lspRangeToMonaco(sym.selectionRange),
            children: sym.children?.map(convertSymbol),
            tags: [],
          });

          // Check if it's DocumentSymbol or SymbolInformation format
          if ('range' in result[0] && 'selectionRange' in result[0]) {
            return (result as LSPDocumentSymbol[]).map(convertSymbol);
          } else {
            // Convert SymbolInformation to DocumentSymbol
            return (result as LSPSymbolInformation[]).map(sym => ({
              name: sym.name,
              detail: sym.containerName || '',
              kind: sym.kind as languages.SymbolKind,
              range: lspRangeToMonaco(sym.location.range),
              selectionRange: lspRangeToMonaco(sym.location.range),
              tags: [],
            }));
          }
        } catch (e) {
          console.error('[LSP] DocumentSymbol error:', e);
          return null;
        }
      },
    });
    providerDisposablesRef.current.push(documentSymbolProvider);

    // Signature Help Provider
    const signatureHelpProvider = monaco.languages.registerSignatureHelpProvider(languageId, {
      signatureHelpTriggerCharacters: ['(', ','],
      signatureHelpRetriggerCharacters: [',', ')'],
      provideSignatureHelp: async (model, position): Promise<languages.SignatureHelpResult | null> => {
        try {
          const result = await sendRequest<LSPSignatureHelp | null>('textDocument/signatureHelp', makeTextDocumentPositionParams(position));
          if (!result || result.signatures.length === 0) return null;

          return {
            value: {
              signatures: result.signatures.map(sig => ({
                label: sig.label,
                documentation: typeof sig.documentation === 'string'
                  ? sig.documentation
                  : sig.documentation?.value,
                parameters: sig.parameters?.map(param => ({
                  label: param.label,
                  documentation: typeof param.documentation === 'string'
                    ? param.documentation
                    : param.documentation?.value,
                })) || [],
              })),
              activeSignature: result.activeSignature ?? 0,
              activeParameter: result.activeParameter ?? 0,
            },
            dispose: () => {},
          };
        } catch (e) {
          console.error('[LSP] SignatureHelp error:', e);
          return null;
        }
      },
    });
    providerDisposablesRef.current.push(signatureHelpProvider);

    // Code Action Provider
    const codeActionProvider = monaco.languages.registerCodeActionProvider(languageId, {
      provideCodeActions: async (model, range, context): Promise<languages.CodeActionList | null> => {
        try {
          const result = await sendRequest<LSPCodeAction[] | null>('textDocument/codeAction', {
            textDocument: { uri: documentUriRef.current },
            range: {
              start: monacoPositionToLsp({ lineNumber: range.startLineNumber, column: range.startColumn }),
              end: monacoPositionToLsp({ lineNumber: range.endLineNumber, column: range.endColumn }),
            },
            context: {
              diagnostics: context.markers.map(m => ({
                range: {
                  start: { line: m.startLineNumber - 1, character: m.startColumn - 1 },
                  end: { line: m.endLineNumber - 1, character: m.endColumn - 1 },
                },
                message: m.message,
                severity: m.severity === monaco.MarkerSeverity.Error ? 1
                  : m.severity === monaco.MarkerSeverity.Warning ? 2
                  : m.severity === monaco.MarkerSeverity.Info ? 3
                  : 4,
              })),
            },
          });
          if (!result || result.length === 0) return null;

          return {
            actions: result.map(action => ({
              title: action.title,
              kind: action.kind,
              isPreferred: action.isPreferred,
              edit: action.edit ? {
                edits: Object.entries(action.edit.changes || {}).flatMap(([uri, edits]) =>
                  edits.map(edit => ({
                    resource: monaco.Uri.parse(uri),
                    textEdit: {
                      range: lspRangeToMonaco(edit.range),
                      text: edit.newText,
                    },
                    versionId: undefined,
                  }))
                ),
              } : undefined,
            })),
            dispose: () => {},
          };
        } catch (e) {
          console.error('[LSP] CodeAction error:', e);
          return null;
        }
      },
    });
    providerDisposablesRef.current.push(codeActionProvider);

    // Rename Provider
    const renameProvider = monaco.languages.registerRenameProvider(languageId, {
      provideRenameEdits: async (model, position, newName): Promise<languages.WorkspaceEdit | null> => {
        try {
          const result = await sendRequest<LSPWorkspaceEdit | null>('textDocument/rename', {
            ...makeTextDocumentPositionParams(position),
            newName,
          });
          if (!result) return null;

          const edits: languages.IWorkspaceTextEdit[] = [];
          if (result.changes) {
            for (const [uri, textEdits] of Object.entries(result.changes)) {
              for (const edit of textEdits) {
                edits.push({
                  resource: monaco.Uri.parse(uri),
                  textEdit: {
                    range: lspRangeToMonaco(edit.range),
                    text: edit.newText,
                  },
                  versionId: undefined,
                });
              }
            }
          }
          return { edits };
        } catch (e) {
          console.error('[LSP] Rename error:', e);
          return null;
        }
      },
      resolveRenameLocation: async (model, position): Promise<languages.RenameLocation | null> => {
        try {
          const result = await sendRequest<{ range: LSPRange; placeholder: string } | null>('textDocument/prepareRename', makeTextDocumentPositionParams(position));
          if (!result) return null;

          return {
            range: lspRangeToMonaco(result.range),
            text: result.placeholder,
          };
        } catch (e) {
          console.error('[LSP] PrepareRename error:', e);
          return null;
        }
      },
    });
    providerDisposablesRef.current.push(renameProvider);

    // Document Formatting Provider
    const formattingProvider = monaco.languages.registerDocumentFormattingEditProvider(languageId, {
      provideDocumentFormattingEdits: async (model, options): Promise<languages.TextEdit[] | null> => {
        try {
          const result = await sendRequest<LSPTextEdit[] | null>('textDocument/formatting', {
            textDocument: { uri: documentUriRef.current },
            options: {
              tabSize: options.tabSize,
              insertSpaces: options.insertSpaces,
            },
          });
          if (!result) return null;

          return result.map(edit => ({
            range: lspRangeToMonaco(edit.range),
            text: edit.newText,
          }));
        } catch (e) {
          console.error('[LSP] Formatting error:', e);
          return null;
        }
      },
    });
    providerDisposablesRef.current.push(formattingProvider);

    // Document Highlight Provider
    const highlightProvider = monaco.languages.registerDocumentHighlightProvider(languageId, {
      provideDocumentHighlights: async (model, position): Promise<languages.DocumentHighlight[] | null> => {
        try {
          const result = await sendRequest<Array<{ range: LSPRange; kind?: number }> | null>('textDocument/documentHighlight', makeTextDocumentPositionParams(position));
          if (!result) return null;

          return result.map(h => ({
            range: lspRangeToMonaco(h.range),
            kind: h.kind as languages.DocumentHighlightKind ?? monaco.languages.DocumentHighlightKind.Text,
          }));
        } catch (e) {
          console.error('[LSP] DocumentHighlight error:', e);
          return null;
        }
      },
    });
    providerDisposablesRef.current.push(highlightProvider);

    console.log('[LSP] Monaco providers registered');
  }, [sendRequest]);

  /**
   * Initialize LSP connection
   */
  const initializeLSP = useCallback(async () => {
    if (!editor) return;

    try {
      const initResult = await sendRequest('initialize', {
        processId: null,
        rootUri: null,
        capabilities: {
          textDocument: {
            synchronization: {
              dynamicRegistration: true,
              willSave: false,
              didSave: true,
              willSaveWaitUntil: false,
            },
            completion: {
              dynamicRegistration: true,
              completionItem: {
                snippetSupport: true,
                commitCharactersSupport: true,
                documentationFormat: ['markdown', 'plaintext'],
              },
            },
            hover: {
              dynamicRegistration: true,
              contentFormat: ['markdown', 'plaintext'],
            },
            signatureHelp: {
              dynamicRegistration: true,
              signatureInformation: {
                documentationFormat: ['markdown', 'plaintext'],
              },
            },
            definition: {
              dynamicRegistration: true,
            },
            references: {
              dynamicRegistration: true,
            },
            documentHighlight: {
              dynamicRegistration: true,
            },
            documentSymbol: {
              dynamicRegistration: true,
              hierarchicalDocumentSymbolSupport: true,
            },
            formatting: {
              dynamicRegistration: true,
            },
            codeAction: {
              dynamicRegistration: true,
              codeActionLiteralSupport: {
                codeActionKind: {
                  valueSet: ['quickfix', 'refactor', 'source'],
                },
              },
            },
            rename: {
              dynamicRegistration: true,
              prepareSupport: true,
            },
            publishDiagnostics: {
              relatedInformation: true,
            },
          },
          workspace: {
            workspaceFolders: false,
            didChangeConfiguration: {
              dynamicRegistration: true,
            },
            didChangeWatchedFiles: {
              dynamicRegistration: true,
            },
          },
        },
        // 构造逻辑见 buildLspInitOptions —— 抽成纯函数是为了可被直接断言，
        // 否则要测「调用方传了什么」就得先拉起一条 WebSocket。
        initializationOptions: buildLspInitOptions(locale, tenantId, domainVocabularies),
      });

      console.log('[LSP] Initialized:', initResult);

      sendNotification('initialized', {});

      // Register Monaco providers after LSP is initialized
      await registerProviders();

      const model = editor.getModel();
      if (model) {
        sendNotification('textDocument/didOpen', {
          textDocument: {
            uri: documentUri,
            languageId: 'aster-cnl',
            version: model.getVersionId(),
            text: model.getValue(),
          },
        });
      }

      setConnected(true);
      setError(null);
    } catch (e) {
      console.error('[LSP] Initialization failed:', e);
      setError(e instanceof Error ? e.message : 'LSP initialization failed');
      setConnected(false);
    }
    // ★tenantId / domainVocabularies 必须进 deps：它们只在 initialize 时下发一次，
    //   若被闭包捕获成旧值，用户在别处增删领域术语后 LSP 会一直用过期词汇。
  }, [
    editor,
    documentUri,
    locale,
    tenantId,
    domainVocabularies,
    sendRequest,
    sendNotification,
    registerProviders,
  ]);

  /**
   * Connect to the LSP server
   */
  const connect = useCallback(async () => {
    if (isDisposedRef.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    if (maxReconnectAttempts > 0 && reconnectAttemptsRef.current >= maxReconnectAttempts) {
      if (!suppressErrors) {
        console.warn('[LSP] Max reconnect attempts reached, giving up');
      }
      return;
    }

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    setConnecting(true);
    setError(null);

    try {
      const wsUrl = getWebSocketUrl();
      if (!wsUrl) {
        throw new Error('LSP WebSocket URL not available');
      }

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          if (!suppressErrors) {
            console.log('[LSP] WebSocket connected');
          }
          reconnectAttemptsRef.current = 0;
          resolve();
        };

        ws.onerror = () => {
          reject(new Error('WebSocket connection failed'));
        };

        setTimeout(() => reject(new Error('Connection timeout')), 10000);
      });

      ws.onmessage = (event) => {
        handleMessage(event.data);
      };

      ws.onclose = (event) => {
        if (!suppressErrors) {
          console.log('[LSP] WebSocket closed:', event.code, event.reason);
        }
        setConnected(false);

        for (const [, pending] of pendingRequestsRef.current) {
          pending.reject(new Error('Connection closed'));
        }
        pendingRequestsRef.current.clear();

        if (autoReconnect && !isDisposedRef.current && event.code !== 1000) {
          reconnectAttemptsRef.current++;
          if (maxReconnectAttempts === 0 || reconnectAttemptsRef.current < maxReconnectAttempts) {
            if (!suppressErrors) {
              console.log(`[LSP] Will reconnect in ${reconnectDelay}ms (attempt ${reconnectAttemptsRef.current})`);
            }
            reconnectTimeoutRef.current = setTimeout(() => {
              // 断线自动重连：connect 递归引用自身（在自身声明前被 onclose 闭包捕获）。
              // 这是自引用重连回调的既有模式，重连由延时定时器异步触发，运行期行为正确；
              // 改用 ref 持有最新 connect 属高风险重构，故此处按既有行为抑制。
              // eslint-disable-next-line react-hooks/immutability
              connect();
            }, reconnectDelay);
          }
        }
      };

      ws.onerror = () => {
        if (!suppressErrors) {
          console.error('[LSP] WebSocket error');
        }
        setError('WebSocket error');
      };

      await initializeLSP();
    } catch (e) {
      reconnectAttemptsRef.current++;
      if (!suppressErrors) {
        console.error('[LSP] Connection failed:', e);
      }
      setError(e instanceof Error ? e.message : 'Connection failed');
      setConnected(false);

      if (autoReconnect && !isDisposedRef.current) {
        if (maxReconnectAttempts === 0 || reconnectAttemptsRef.current < maxReconnectAttempts) {
          reconnectTimeoutRef.current = setTimeout(() => {
            connect();
          }, reconnectDelay);
        }
      }
    } finally {
      setConnecting(false);
    }
  }, [getWebSocketUrl, handleMessage, initializeLSP, autoReconnect, reconnectDelay, maxReconnectAttempts, suppressErrors]);

  /**
   * Disconnect from the LSP server
   */
  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    reconnectAttemptsRef.current = 0;

    // Dispose providers
    providerDisposablesRef.current.forEach(d => d.dispose());
    providerDisposablesRef.current = [];

    if (wsRef.current) {
      wsRef.current.close(1000, 'Client disconnect');
      wsRef.current = null;
    }

    for (const [, pending] of pendingRequestsRef.current) {
      pending.reject(new Error('Disconnected'));
    }
    pendingRequestsRef.current.clear();

    setConnected(false);
    setConnecting(false);
  }, []);

  /**
   * Reconnect to the LSP server
   */
  const reconnect = useCallback(async () => {
    disconnect();
    await connect();
  }, [disconnect, connect]);

  // Auto-connect on mount
  useEffect(() => {
    isDisposedRef.current = false;

    if (autoConnect && editor) {
      connect();
    }

    return () => {
      isDisposedRef.current = true;
      disconnect();
    };
  }, [autoConnect, editor, connect, disconnect]);

  // Sync document changes to LSP
  useEffect(() => {
    if (!editor || !connected) return;

    const model = editor.getModel();
    if (!model) return;

    const disposable = model.onDidChangeContent(() => {
      sendNotification('textDocument/didChange', {
        textDocument: {
          uri: documentUri,
          version: model.getVersionId(),
        },
        contentChanges: [
          {
            text: model.getValue(),
          },
        ],
      });
    });

    return () => disposable.dispose();
  }, [editor, connected, documentUri, sendNotification]);

  return {
    connected,
    connecting,
    error,
    connect,
    disconnect,
    reconnect,
  };
}
