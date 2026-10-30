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
import { buildLspInitOptions, buildLspSettings, shouldApplyDiagnostics } from '@/lib/lsp-init-options';
import { respondToServerRequest } from '@/lib/lsp-server-requests';
import { splitJsonMessages } from '@/lib/lsp-json-frames';
import { selectLspFeatures, type LspFeatures, type LspServerCapabilities } from '@/lib/lsp-features';
import { isMemberAccessPosition } from '@/lib/aster-keyword-completions';
import {
  HandshakeBudget,
  LSP_RATE_LIMITED_CLOSE_CODE,
  LSP_RECONNECT_BASE_MS,
  LSP_RECONNECT_MAX_MS,
  ReconnectScheduler,
  parseRetryAfter,
  sharedHandshakeBudget,
} from '@/lib/lsp-reconnect';

type MonacoNamespace = typeof import('monaco-editor');

export type CNLLocale = 'en-US' | 'zh-CN' | 'de-DE';

export interface UseAsterLSPOptions {
  /** Monaco editor instance */
  editor: editor.IStandaloneCodeEditor | null;
  /**
   * 编辑器**自己的** Monaco 命名空间（@monaco-editor/react onMount 的第二个参数）。
   *
   * ★必须由调用方传入，hook 不得自行 import('monaco-editor')：@monaco-editor/react
   *   未配置 loader 时从 CDN 加载 Monaco，自行 import 得到的是打包进来的**第二份**实例。
   *   provider 注册在那一份上，编辑器永远不会调用——hover/跳转/引用等全部失效，
   *   还白白多下载一份 Monaco。为 null 时不连接。
   */
  monaco: MonacoNamespace | null;
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
  /** 首次重连前的等待（ms），之后指数退避 */
  reconnectDelay?: number;
  /** 重连等待的上限（ms） */
  maxReconnectDelay?: number;
  /** 连续失败多少次后放弃（0 = 不限，默认不限） */
  maxReconnectAttempts?: number;
  /** 握手预算，默认同页所有会话共享（见 lib/lsp-reconnect） */
  handshakeBudget?: HandshakeBudget;
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

/**
 * LSP 会话状态：idle 未连接（未启用或本端已断开）、connecting 首次连接中、connected 已初始化、
 * reconnecting 会话丢失后正在 / 等待重连、disconnected 已断开且暂停重连（页面隐藏、离线或已放弃）。
 */
export type LspConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface UseAsterLSPResult {
  /** Whether connected to LSP server */
  connected: boolean;
  /** 会话状态，供编辑器状态栏提示断线 / 重连 */
  status: LspConnectionStatus;
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

/** LSP 补全请求的超时（毫秒）：超时视为没有上下文补全，不阻塞补全框 */
const COMPLETION_TIMEOUT_MS = 800;

/** LSP TextEdit / InsertReplaceEdit 的范围换算为 Monaco 范围（行列从 1 起）；无 textEdit 返回 null。 */
function completionRange(edit: LSPCompletionItem['textEdit']): languages.CompletionItem['range'] | null {
  if (!edit) return null;
  const toMonaco = (r: LSPRange) => ({
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1,
  });
  if ('range' in edit && edit.range) return toMonaco(edit.range);
  if ('insert' in edit && 'replace' in edit) return { insert: toMonaco(edit.insert), replace: toMonaco(edit.replace) };
  return null;
}

/** LSP CompletionItemKind 中本编辑器采用的上下文补全种类（其余如 Keyword=14、Class=7 交给本地 provider） */
const LSP_COMPLETION_KIND = { Property: 10, Field: 5, Value: 12, EnumMember: 20 } as const;

interface LSPCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  insertText?: string;
  textEdit?: { range: LSPRange; newText: string } | { insert: LSPRange; replace: LSPRange; newText: string };
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
/** 不可重命名时的提示（hook 不在 next-intl 上下文里，按 CNL locale 直接给出） */
const RENAME_REJECT_REASON: Record<CNLLocale, string> = {
  'en-US': 'This element cannot be renamed.',
  'zh-CN': '此处无法重命名。',
  'de-DE': 'Dieses Element kann nicht umbenannt werden.',
};
function renameRejectReason(locale: CNLLocale): string {
  return RENAME_REJECT_REASON[locale] ?? RENAME_REJECT_REASON['en-US'];
}

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
  monaco,
  documentUri,
  locale = 'en-US',
  tenantId,
  domainVocabularies,
  suppressDiagnostics = false,
  autoConnect = true,
  autoReconnect = true,
  reconnectDelay = LSP_RECONNECT_BASE_MS,
  maxReconnectDelay = LSP_RECONNECT_MAX_MS,
  maxReconnectAttempts = 0,
  handshakeBudget = sharedHandshakeBudget,
  suppressErrors = true,
}: UseAsterLSPOptions): UseAsterLSPResult {
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<LspConnectionStatus>('idle');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const requestIdRef = useRef(0);
  const pendingRequestsRef = useRef<Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>>(new Map());
  const isDisposedRef = useRef(false);
  const providerDisposablesRef = useRef<IDisposable[]>([]);
  // ref-latch：把最新的 editor/documentUri prop 镜像进 ref，避免各回调里读到
  // 陈旧闭包。属渲染期同步最新 prop 的惯用写法，ref 值不参与本次渲染输出。
  const editorRef = useRef(editor);
  // eslint-disable-next-line react-hooks/refs
  editorRef.current = editor;
  const monacoRef = useRef(monaco);
  // eslint-disable-next-line react-hooks/refs
  monacoRef.current = monaco;
  // ★以编辑器模型的真实 URI 为准（服务端返回的位置都带这个 URI，Monaco 只认完全一致的模型 URI），
  //   documentUri prop 仅在还没有模型时兜底。
  const documentUriRef = useRef(documentUri);
  // eslint-disable-next-line react-hooks/refs
  documentUriRef.current = editor?.getModel()?.uri.toString() ?? documentUri;
  // 补全 provider 注册一次、按当前语言判断句末 "."，故经 ref 读取
  const localeRef = useRef(locale);
  // eslint-disable-next-line react-hooks/refs
  localeRef.current = locale;

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
    async <T>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T> => {
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

        // 可选超时：服务端卡住而连接未断时，挂起的请求永不完成；到时清掉挂起条目、
        // 通知服务端取消（$/cancelRequest），并以超时失败结束
        const timer = opts?.timeoutMs
          ? setTimeout(() => {
              if (!pendingRequestsRef.current.delete(id)) return;
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } }));
              }
              reject(new Error(`LSP request ${method} timed out`));
            }, opts.timeoutMs)
          : undefined;

        pendingRequestsRef.current.set(id, {
          resolve: (r: unknown) => { clearTimeout(timer); (resolve as (r: unknown) => void)(r); },
          reject: (e: Error) => { clearTimeout(timer); reject(e); },
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
          const monaco = monacoRef.current;
          if (currentEditor && monaco) {
            const model = currentEditor.getModel();
            if (model) {
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

    // 带 id 的 method 消息是服务端**请求**，必须应答（否则服务端那一侧永久挂起）。
    const reply = respondToServerRequest(message);
    if (reply) {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
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
    for (const message of splitJsonMessages(data)) {
      processMessage(message as LSPMessage);
    }
  }, [processMessage]);

  /**
   * Register Monaco language providers for LSP features
   */
  const registerProviders = useCallback(async (features: LspFeatures) => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    const languageId = 'aster-cnl';

    // ★同一语言 id 下还有别的模型（如 AI diff 预览也用 aster-cnl）。provider 只服务 LSP 文档，
    //   其余模型返回空——否则在预览里 hover 会显示主文档的结果。
    const isLspModel = (model: editor.ITextModel) => model.uri.toString() === documentUriRef.current;

    // ★同一功能的失败只报一次：provider 随光标/按键频繁触发，逐次 console.error 会刷屏。
    const reportedFailures = new Set<string>();
    const reportProviderError = (feature: string, e: unknown) => {
      if (reportedFailures.has(feature)) return;
      reportedFailures.add(feature);
      if (!suppressErrors) console.warn(`[LSP] ${feature} request failed (further failures suppressed):`, e);
    };

    // Dispose existing providers
    providerDisposablesRef.current.forEach(d => d.dispose());
    providerDisposablesRef.current = [];

    // Helper to make LSP requests with proper parameters
    const makeTextDocumentPositionParams = (position: Position) => ({
      textDocument: { uri: documentUriRef.current },
      position: monacoPositionToLsp(position),
    });

    // Hover Provider
    if (features.hover) {
      const hoverProvider = monaco.languages.registerHoverProvider(languageId, {
        provideHover: async (model, position): Promise<languages.Hover | null> => {
          if (!isLspModel(model)) return null;
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
            reportProviderError('Hover', e);
            return null;
          }
        },
      });
      providerDisposablesRef.current.push(hoverProvider);
    }

    // Definition Provider
    if (features.definition) {
      const definitionProvider = monaco.languages.registerDefinitionProvider(languageId, {
        provideDefinition: async (model, position): Promise<languages.Definition | null> => {
          if (!isLspModel(model)) return null;
          try {
            const result = await sendRequest<LSPLocation | LSPLocation[] | null>('textDocument/definition', makeTextDocumentPositionParams(position));
            if (!result) return null;

            const locations = Array.isArray(result) ? result : [result];
            return locations.map(loc => ({
              uri: monaco.Uri.parse(loc.uri),
              range: lspRangeToMonaco(loc.range),
            }));
          } catch (e) {
            reportProviderError('Definition', e);
            return null;
          }
        },
      });
      providerDisposablesRef.current.push(definitionProvider);
    }

    // References Provider
    if (features.references) {
      const referencesProvider = monaco.languages.registerReferenceProvider(languageId, {
        provideReferences: async (model, position, context): Promise<languages.Location[] | null> => {
          if (!isLspModel(model)) return null;
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
            reportProviderError('References', e);
            return null;
          }
        },
      });
      providerDisposablesRef.current.push(referencesProvider);
    }

    // Document Symbol Provider
    if (features.documentSymbol) {
      const documentSymbolProvider = monaco.languages.registerDocumentSymbolProvider(languageId, {
        provideDocumentSymbols: async (_model): Promise<languages.DocumentSymbol[] | null> => {
          if (!isLspModel(_model)) return null;
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
            reportProviderError('DocumentSymbol', e);
            return null;
          }
        },
      });
      providerDisposablesRef.current.push(documentSymbolProvider);
    }

    // Completion Provider（上下文补全）
    //
    // ★只取服务端按上下文给出的结果：`x.` 后按接收者类型列出的字段、@control 键等
    //   （构造字段名位置不在预判范围内，不向 LSP 请求）。
    //   服务端在其他位置返回的通用列表（全部关键字 + 英文类型名）丢弃——关键字补全归本地 provider
    //   （按 locale 与用户别名给词），接上会重复，zh 下英文类型名还是错词。
    //   触发字符只用 '.'。quick suggestions 仍会对每个新词调用本 provider，故入口先做廉价预判
    //   （只在成员访问与字符串内发请求），请求另有超时，见下方。
    if (features.completion) {
      const kindMap: Record<number, languages.CompletionItemKind> = {
        [LSP_COMPLETION_KIND.Field]: monaco.languages.CompletionItemKind.Field,
        [LSP_COMPLETION_KIND.Property]: monaco.languages.CompletionItemKind.Property,
        [LSP_COMPLETION_KIND.Value]: monaco.languages.CompletionItemKind.Value,
        [LSP_COMPLETION_KIND.EnumMember]: monaco.languages.CompletionItemKind.EnumMember,
      };
      const completionProvider = monaco.languages.registerCompletionItemProvider(languageId, {
        triggerCharacters: ['.'],
        provideCompletionItems: async (model, position, context, token): Promise<languages.CompletionList | null> => {
          if (!isLspModel(model)) return null;
          // ★廉价预判（审查 M1）：本地与 LSP provider 同组，Monaco 会等齐同组结果才出补全框。
          //   只在上下文补全可能有结果的位置发请求——成员访问（`x.` / `x.前缀`）与字符串内
          //   （@control("…") 键）；其余位置立即返回，本地关键字不被 LSP 往返拖慢。
          const linePrefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
          const inString = ((linePrefix.match(/"/g) ?? []).length) % 2 === 1;
          const memberAccess = !inString && isMemberAccessPosition(linePrefix);
          if (!inString && !memberAccess) return null;
          // ★句末 "."（审查 M4 / 复审 N1）：只有句末用 "." 的语言（en-US / de-DE）里，行尾刚由 "."
          //   自动触发的补全多半是句号——此时弹字段列表，回车（acceptSuggestionOnEnter）会插入字段而不是换行。
          //   不给建议、标记 incomplete，用户接着输入字母时再查。zh-CN 句末是 "。"、行尾 `x.` 必是成员访问；
          //   手动 Ctrl+Space（Invoke）表示用户确实要补全：两者都照常请求。
          const periodEndsSentence = localeRef.current === 'en-US' || localeRef.current === 'de-DE';
          const autoTriggered = (context?.triggerKind ?? 0) !== monaco.languages.CompletionTriggerKind.Invoke;
          if (
            periodEndsSentence && autoTriggered && memberAccess && linePrefix.endsWith('.')
            && position.column >= model.getLineMaxColumn(position.lineNumber)
          ) {
            return { suggestions: [], incomplete: true };
          }
          try {
            const result = await sendRequest<LSPCompletionItem[] | { items: LSPCompletionItem[] } | null>('textDocument/completion', {
              ...makeTextDocumentPositionParams(position),
              // Monaco 的 triggerKind 从 0 起（Invoke=0），LSP 从 1 起（Invoked=1）
              context: {
                triggerKind: (context?.triggerKind ?? 0) + 1,
                ...(context?.triggerCharacter ? { triggerCharacter: context.triggerCharacter } : {}),
              },
            }, { timeoutMs: COMPLETION_TIMEOUT_MS });
            if (token?.isCancellationRequested) return null;
            const items = Array.isArray(result) ? result : result?.items ?? [];
            const word = model.getWordUntilPosition(position);
            const wordRange = {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: word.startColumn,
              endColumn: word.endColumn,
            };
            return {
              suggestions: items
                .filter((item) => item.kind !== undefined && kindMap[item.kind] !== undefined)
                .map((item) => ({
                  label: item.label,
                  kind: kindMap[item.kind!]!,
                  // ★服务端给了 textEdit 就按它的范围替换（审查 M2）：如 @control("GDPR: 覆盖引号后到光标，
                  //   按单词边界（止于 ':'）替换会插入重复前缀 GDPR:GDPR:ART22
                  insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
                  ...(item.detail ? { detail: item.detail } : {}),
                  range: completionRange(item.textEdit) ?? wordRange,
                })),
            };
          } catch (e) {
            // 超时（服务端卡住）或连接问题：补全不可用时静默返回，本地关键字补全照常
            reportProviderError('Completion', e);
            return null;
          }
        },
      });
      providerDisposablesRef.current.push(completionProvider);
    }

    // Signature Help Provider
    if (features.signatureHelp) {
      const signatureHelpProvider = monaco.languages.registerSignatureHelpProvider(languageId, {
        signatureHelpTriggerCharacters: ['(', ','],
        signatureHelpRetriggerCharacters: [',', ')'],
        provideSignatureHelp: async (model, position): Promise<languages.SignatureHelpResult | null> => {
          if (!isLspModel(model)) return null;
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
            reportProviderError('SignatureHelp', e);
            return null;
          }
        },
      });
      providerDisposablesRef.current.push(signatureHelpProvider);
    }

    // Code Action Provider
    if (features.codeAction) {
      const codeActionProvider = monaco.languages.registerCodeActionProvider(languageId, {
        provideCodeActions: async (model, range, context): Promise<languages.CodeActionList | null> => {
          if (!isLspModel(model)) return null;
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
                  // ★code 必须带上：服务端的 Quick Fix 按 code 识别诊断（message 已本地化）
                  code: typeof m.code === 'string' ? m.code : m.code?.value,
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
            reportProviderError('CodeAction', e);
            return null;
          }
        },
      });
      providerDisposablesRef.current.push(codeActionProvider);
    }

    // Rename Provider
    if (features.rename) {
      const renameProvider = monaco.languages.registerRenameProvider(languageId, {
        provideRenameEdits: async (model, position, newName): Promise<languages.WorkspaceEdit | null> => {
          if (!isLspModel(model)) return null;
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
            reportProviderError('Rename', e);
            return null;
          }
        },
        resolveRenameLocation: async (model, position): Promise<(languages.RenameLocation & languages.Rejection) | null> => {
          if (!isLspModel(model)) return null;
          // ★服务端回 null（冠词、关键字、词汇词等不可重命名）时必须明确拒绝：
          //   回 null 在 Monaco 里是「没有意见」，它会照样对光标下的词调用 provideRenameEdits。
          const reject = (): languages.RenameLocation & languages.Rejection => {
            const word = model.getWordAtPosition(position);
            return {
              range: word
                ? { startLineNumber: position.lineNumber, startColumn: word.startColumn, endLineNumber: position.lineNumber, endColumn: word.endColumn }
                : { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column },
              text: word?.word ?? '',
              rejectReason: renameRejectReason(locale),
            };
          };
          try {
            const result = await sendRequest<{ range: LSPRange; placeholder: string } | null>('textDocument/prepareRename', makeTextDocumentPositionParams(position));
            if (!result) return reject();

            return {
              range: lspRangeToMonaco(result.range),
              text: result.placeholder,
            };
          } catch (e) {
            reportProviderError('PrepareRename', e);
            return reject();
          }
        },
      });
      providerDisposablesRef.current.push(renameProvider);
    }

    // Document Formatting Provider
    if (features.formatting) {
      const formattingProvider = monaco.languages.registerDocumentFormattingEditProvider(languageId, {
        provideDocumentFormattingEdits: async (model, options): Promise<languages.TextEdit[] | null> => {
          if (!isLspModel(model)) return null;
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
            reportProviderError('Formatting', e);
            return null;
          }
        },
      });
      providerDisposablesRef.current.push(formattingProvider);
    }

    // Document Highlight Provider
    if (features.documentHighlight) {
      const highlightProvider = monaco.languages.registerDocumentHighlightProvider(languageId, {
        provideDocumentHighlights: async (model, position): Promise<languages.DocumentHighlight[] | null> => {
          if (!isLspModel(model)) return null;
          try {
            const result = await sendRequest<Array<{ range: LSPRange; kind?: number }> | null>('textDocument/documentHighlight', makeTextDocumentPositionParams(position));
            if (!result) return null;

            return result.map(h => ({
              range: lspRangeToMonaco(h.range),
              kind: h.kind as languages.DocumentHighlightKind ?? monaco.languages.DocumentHighlightKind.Text,
            }));
          } catch (e) {
            reportProviderError('DocumentHighlight', e);
            return null;
          }
        },
      });
      providerDisposablesRef.current.push(highlightProvider);
    }

    console.log('[LSP] Monaco providers registered');
  }, [sendRequest, suppressErrors, locale]);

  /**
   * Initialize LSP connection
   */
  const initializeLSP = useCallback(async () => {
    if (!editor) return;

    const model = editor.getModel();
    if (model) documentUriRef.current = model.uri.toString();

    const initResult = await sendRequest<{ capabilities?: LspServerCapabilities }>('initialize', {
      processId: null,
      rootUri: null,
      capabilities: {
        textDocument: {
          synchronization: {
            dynamicRegistration: false,
            willSave: false,
            didSave: true,
            willSaveWaitUntil: false,
          },
          completion: {
            dynamicRegistration: false,
            completionItem: {
              snippetSupport: true,
              commitCharactersSupport: true,
              documentationFormat: ['markdown', 'plaintext'],
            },
          },
          hover: {
            dynamicRegistration: false,
            contentFormat: ['markdown', 'plaintext'],
          },
          signatureHelp: {
            dynamicRegistration: false,
            signatureInformation: {
              documentationFormat: ['markdown', 'plaintext'],
            },
          },
          definition: {
            dynamicRegistration: false,
          },
          references: {
            dynamicRegistration: false,
          },
          documentHighlight: {
            dynamicRegistration: false,
          },
          documentSymbol: {
            dynamicRegistration: false,
            hierarchicalDocumentSymbolSupport: true,
          },
          formatting: {
            dynamicRegistration: false,
          },
          codeAction: {
            dynamicRegistration: false,
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: ['quickfix', 'refactor', 'source'],
              },
            },
          },
          rename: {
            dynamicRegistration: false,
            prepareSupport: true,
          },
          publishDiagnostics: {
            relatedInformation: true,
          },
        },
        workspace: {
          workspaceFolders: false,
          didChangeConfiguration: {
            dynamicRegistration: false,
          },
          didChangeWatchedFiles: {
            dynamicRegistration: false,
          },
        },
      },
      // 构造逻辑见 buildLspInitOptions —— 抽成纯函数是为了可被直接断言，
      // 否则要测「调用方传了什么」就得先拉起一条 WebSocket。
      initializationOptions: buildLspInitOptions(locale, tenantId, domainVocabularies),
    });

    console.log('[LSP] Initialized:', initResult);

    sendNotification('initialized', {});

    // ★服务端只从 settings 读 locale（aster-lang-ts server.js 的 onDidChangeConfiguration
    //   → s.locale）；网关传的 ASTER_LOCALE 环境变量与 initializationOptions.locale
    //   都不生效。客户端未声明 workspace.configuration，服务端就采用这里推送的 settings。
    //   不推送 → 服务端按英文解析 zh/de 文档，hover/跳转全部报「Unexpected character」。
    //   必须在 didOpen 之前发，首个解析才会用对 lexicon。
    sendNotification('workspace/didChangeConfiguration', {
      settings: { asterLanguageServer: buildLspSettings(locale) },
    });

    // 只注册当前服务端真正可用的功能（见 selectLspFeatures）
    await registerProviders(selectLspFeatures(locale, initResult?.capabilities));

    if (model) {
      sendNotification('textDocument/didOpen', {
        textDocument: {
          uri: documentUriRef.current,
          languageId: 'aster-cnl',
          version: model.getVersionId(),
          text: model.getValue(),
        },
      });
    }

    // ★tenantId / domainVocabularies 必须进 deps：它们只在 initialize 时下发一次，
    //   若被闭包捕获成旧值，用户在别处增删领域术语后 LSP 会一直用过期词汇。
  }, [
    editor,
    locale,
    tenantId,
    domainVocabularies,
    sendRequest,
    sendNotification,
    registerProviders,
  ]);

  /*
   * 断线重连（生产复测第 6 轮）：见 lib/lsp-reconnect。
   * ★只有本端主动断开（disconnect，含 effect 重跑与卸载）不重连；服务端关闭会话（含 1000
   *   "Language server stopped"）、握手失败、初始化失败都按退避重连。
   * ★每个会话的回调都先核对 wsRef.current === ws：effect 重跑时旧会话的关闭 / 初始化失败
   *   不得改动新会话的状态（第 6 轮现场：旧会话以 1000 "Client disconnect" 关闭时拒掉了新会话的
   *   initialize，新会话从此连着却没初始化，补全只剩单词建议）。
   */
  // 发起连接的函数由下方 effect 绑定（connect 随依赖变化）
  const [scheduler] = useState(() => new ReconnectScheduler({
    budget: handshakeBudget,
    shouldPause: () => typeof document !== 'undefined' && (document.visibilityState === 'hidden' || navigator.onLine === false),
    onPause: () => setStatus('disconnected'),
    baseMs: reconnectDelay,
    maxMs: maxReconnectDelay,
    maxAttempts: maxReconnectAttempts,
    onGiveUp: () => setStatus('disconnected'),
  }));

  /** 当前会话已失效（失败或被服务端关闭）：清理并按退避安排重连。 */
  const sessionFailed = useCallback((ws: WebSocket, retryAfterMs: number | null, message: string) => {
    if (wsRef.current !== ws) return;
    wsRef.current = null;
    ws.onclose = null;
    ws.close();
    for (const [, pending] of pendingRequestsRef.current) {
      pending.reject(new Error('Connection closed'));
    }
    pendingRequestsRef.current.clear();
    setConnected(false);
    setError(message);
    if (isDisposedRef.current || !autoReconnect) {
      setStatus('disconnected');
      return;
    }
    setStatus('reconnecting');
    scheduler.failed(retryAfterMs);
  }, [autoReconnect, scheduler]);

  /**
   * Connect to the LSP server
   */
  const connect = useCallback(async () => {
    if (isDisposedRef.current) return;
    if (wsRef.current) return;

    const wsUrl = getWebSocketUrl();
    if (!wsUrl) {
      setError('LSP WebSocket URL not available');
      return;
    }

    scheduler.cancel();
    setStatus((prev) => (prev === 'reconnecting' || prev === 'disconnected' ? 'reconnecting' : 'connecting'));
    setConnecting(true);
    setError(null);

    handshakeBudget.record();
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      if (wsRef.current === ws) handleMessage(event.data);
    };
    ws.onclose = (event) => {
      if (!suppressErrors) {
        console.log('[LSP] WebSocket closed:', event.code, event.reason);
      }
      const retryAfterMs = event.code === LSP_RATE_LIMITED_CLOSE_CODE ? parseRetryAfter(event.reason) : null;
      sessionFailed(ws, retryAfterMs, event.reason || 'Connection closed');
    };

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Connection timeout')), 10000);
        ws.onopen = () => { clearTimeout(timer); resolve(); };
        ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket connection failed')); };
      });
      if (wsRef.current !== ws) return;
      ws.onerror = () => {
        if (!suppressErrors) {
          console.error('[LSP] WebSocket error');
        }
      };

      await initializeLSP();
      if (wsRef.current !== ws) return;
      scheduler.succeeded();
      setConnected(true);
      setStatus('connected');
    } catch (e) {
      if (!suppressErrors) {
        console.error('[LSP] Connection failed:', e);
      }
      sessionFailed(ws, null, e instanceof Error ? e.message : 'Connection failed');
    } finally {
      if (wsRef.current === ws || wsRef.current === null) setConnecting(false);
    }
  }, [getWebSocketUrl, handleMessage, initializeLSP, sessionFailed, handshakeBudget, scheduler, suppressErrors]);
  useEffect(() => {
    scheduler.setConnect(() => { void connect(); });
  }, [scheduler, connect]);

  /**
   * Disconnect from the LSP server
   */
  const disconnect = useCallback(() => {
    scheduler.cancel();

    // Dispose providers
    providerDisposablesRef.current.forEach(d => d.dispose());
    providerDisposablesRef.current = [];

    const ws = wsRef.current;
    // 先摘掉引用再关闭：该会话随后的 onclose 据此识别为本端主动断开，不触发重连
    wsRef.current = null;
    ws?.close(1000, 'Client disconnect');

    for (const [, pending] of pendingRequestsRef.current) {
      pending.reject(new Error('Disconnected'));
    }
    pendingRequestsRef.current.clear();

    setConnected(false);
    setConnecting(false);
    setStatus('idle');
  }, [scheduler]);

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

    // 没有编辑器自己的 Monaco 实例就不连：provider 无处注册，连上也只是空跑 didChange。
    if (autoConnect && editor && monaco) {
      // 连接外部系统（WebSocket）正是 effect 的职责；connect 同步置 connecting 状态以便状态栏即时反映
      // eslint-disable-next-line react-hooks/set-state-in-effect
      connect();
    }

    return () => {
      isDisposedRef.current = true;
      disconnect();
    };
  }, [autoConnect, editor, monaco, connect, disconnect]);

  // 页面重新可见 / 网络恢复：有待执行的重连时立即重试（仍受 Retry-After 与握手预算约束）
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const retryNow = () => {
      if (document.visibilityState === 'hidden') return;
      scheduler.retryNow();
    };
    document.addEventListener('visibilitychange', retryNow);
    window.addEventListener('online', retryNow);
    return () => {
      document.removeEventListener('visibilitychange', retryNow);
      window.removeEventListener('online', retryNow);
    };
  }, [scheduler]);

  // Sync document changes to LSP
  useEffect(() => {
    if (!editor || !connected) return;

    const model = editor.getModel();
    if (!model) return;

    const disposable = model.onDidChangeContent(() => {
      sendNotification('textDocument/didChange', {
        textDocument: {
          uri: documentUriRef.current,
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
    status,
    connecting,
    error,
    connect,
    disconnect,
    reconnect,
  };
}
