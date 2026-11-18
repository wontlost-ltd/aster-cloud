'use client';

/*
 * 策略详情页「导出为 Cedar」（ADR 0047 §6）。
 * 调所有者路由导出可执行版本：可导出时原样下载 <module>.cedar 与 <module>.cedarschema.json（模块名取编译器给出的
 * moduleName），并报告与 Cedar 比对过的探针数；不可导出时列出诊断；无可执行版本时提示先批准。文案由服务端页面预渲染传入。
 * 可导出的规则不止一条时（E720 多候选，#661）列出候选让用户选择，再带 functionName 导出所选规则。
 *
 * 布局（#786）：按钮放在页头右上的操作组里（与执行 / 编辑 / 删除同组同样式），结果、错误与「先批准」提示放在
 * 页头下方紧贴操作组的状态区里。二者分处页头内外，故用 CedarExportProvider 共享导出状态：
 * - CedarExportButton：操作组里的按钮。导出中文案换成「导出中…」时按钮宽度不变（两段文案叠放、只显示其一），
 *   同组其余按钮不会被挤动；
 * - CedarExportStatus：始终挂载的 aria-live 状态区（空时不占高度），结果出现在操作组下方、不影响页头里的其它操作。
 * 是否显示整组由服务端按可导出性判定（见 lib/cedar-exportability），客户端不再请求，按钮不会先出现再消失。
 */
import { createContext, useCallback, useContext, useId, useMemo, useState, type ReactNode } from 'react';
import type { PolicyCedarExportResponse, PolicyDiagnostic } from '@/services/policy/policy-api';
import { cedarRuleCandidates } from '@/lib/cedar-export-rules';
import { actionErrorCode } from '@/lib/api/error-envelope';

export interface CedarExportLabels {
  button: string;
  exporting: string;
  /** 含 {count} 占位符的原始文案，按探针数在客户端替换 */
  verified: string;
  notExportable: string;
  failed: string;
  /** 服务端导出并发已满（503 cedar_export_busy），提示稍后重试 */
  busy: string;
  noExecutableVersion: string;
  /** 无可执行版本时引导去版本页的链接文案 */
  versionsLink: string;
  /** 导出的 schema 只覆盖规则提到的形状（ADR 0047 §5「对外形态收窄」），按 schema 校验请求的网关会更严 */
  schemaNote: string;
  /** 多条规则可导出时选择框的标签 */
  chooseRule: string;
  /** 导出所选规则的按钮 */
  exportRule: string;
}

interface CedarExportProviderProps {
  policyId: string;
  labels: CedarExportLabels;
  /**
   * 服务端渲染时是否已有批准版本。没有时按钮直接禁用并说明原因，免得用户点了才收到 409；
   * 409 分支仍保留，覆盖页面打开后版本被归档等竞态。
   */
  hasExecutableVersion: boolean;
  /** 版本与审批页地址（已带 locale） */
  versionsHref: string;
}

type ExportState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'verified'; count: number }
  | { kind: 'notExportable'; diagnostics: PolicyDiagnostic[] }
  | { kind: 'chooseRule'; candidates: string[] }
  | { kind: 'error'; message: string };

function downloadFile(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

// 失败文案按状态与稳定错误码在客户端本地化（#688），不显示服务端原文：409 为无可执行版本，提示先批准；
// cedar_export_busy 为服务端导出并发已满，提示稍后重试；其余失败统一显示 failed
async function failureMessage(res: Response, labels: CedarExportLabels): Promise<string> {
  if (res.status === 409) return labels.noExecutableVersion;
  const body: unknown = await res.json().catch(() => null);
  return actionErrorCode(body) === 'cedar_export_busy' ? labels.busy : labels.failed;
}

// 未指定规则时不带请求体（服务端按唯一候选导出）；指定时带 functionName
function exportRequest(functionName: string | undefined): RequestInit {
  if (!functionName) return { method: 'POST' };
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ functionName }) };
}

async function runExport(policyId: string, labels: CedarExportLabels, functionName?: string): Promise<ExportState> {
  const res = await fetch(`/api/policies/${policyId}/export/cedar`, exportRequest(functionName));
  if (!res.ok) return { kind: 'error', message: await failureMessage(res, labels) };
  const data = (await res.json()) as PolicyCedarExportResponse;
  if (!data.exportable || data.policies == null || data.schemaText == null) {
    const diagnostics = data.diagnostics ?? [];
    // 已指定规则时不再给选择（服务端不会对指定的规则再报多候选）
    const candidates = functionName ? [] : cedarRuleCandidates(diagnostics);
    return candidates.length > 1 ? { kind: 'chooseRule', candidates } : { kind: 'notExportable', diagnostics };
  }
  const moduleName = data.moduleName ?? 'policy';
  // 两个文件都原样写出、不重新序列化：其 SHA-256 即 aster-api 审计记录的 policiesHash / schemaHash
  downloadFile(`${moduleName}.cedar`, data.policies, 'text/plain');
  downloadFile(`${moduleName}.cedarschema.json`, data.schemaText, 'application/json');
  return { kind: 'verified', count: data.probes?.count ?? 0 };
}

function DiagnosticList({ diagnostics }: { diagnostics: PolicyDiagnostic[] }) {
  return (
    <ul className="mt-2 space-y-1 text-sm text-red-700">
      {diagnostics.map((d, i) => (
        <li key={`${d.code ?? ''}-${d.startLine}-${d.startColumn}-${i}`} className="font-mono">
          {d.code && <span className="font-semibold">{d.code}</span>}
          <span className="ml-2">{`${d.startLine}:${d.startColumn}`}</span>
          <span className="ml-2">{d.message}</span>
        </li>
      ))}
    </ul>
  );
}

function ExportResult({ state, labels }: { state: ExportState; labels: CedarExportLabels }) {
  if (state.kind === 'verified') {
    return (
      <div className="text-sm sm:text-right">
        <p className="text-green-700">{labels.verified.replace('{count}', String(state.count))}</p>
        <p className="mt-1 text-fg-muted">{labels.schemaNote}</p>
      </div>
    );
  }
  if (state.kind === 'error') {
    return <p className="text-sm text-red-700" role="alert">{state.message}</p>;
  }
  if (state.kind !== 'notExportable') return null;
  return (
    <div role="alert">
      <p className="text-sm font-medium text-red-700">{labels.notExportable}</p>
      <DiagnosticList diagnostics={state.diagnostics} />
    </div>
  );
}

function RuleChooser({ candidates, labels, busy, onExport }: {
  candidates: string[];
  labels: CedarExportLabels;
  busy: boolean;
  onExport: (functionName: string) => void;
}) {
  const [chosen, setChosen] = useState(candidates[0]!);
  const selectId = useId();
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <label htmlFor={selectId} className="text-fg">{labels.chooseRule}</label>
      <select
        id={selectId}
        value={chosen}
        onChange={(e) => setChosen(e.target.value)}
        className="rounded-md border border-border bg-bg px-2 py-1 font-mono text-sm text-fg"
      >
        {candidates.map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
      <button
        type="button"
        onClick={() => onExport(chosen)}
        disabled={busy}
        className="inline-flex items-center rounded-md bg-primary px-3 py-1 text-sm font-semibold text-primary-fg hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
      >
        {labels.exportRule}
      </button>
    </div>
  );
}

export const NO_VERSION_HINT_ID = 'cedar-export-no-version';

interface CedarExportContextValue {
  labels: CedarExportLabels;
  hasExecutableVersion: boolean;
  versionsHref: string;
  state: ExportState;
  handleExport: (functionName?: string) => void;
}

const CedarExportContext = createContext<CedarExportContextValue | null>(null);

/** 「导出」菜单（policy-export-menu）在 Cedar 不可见时不挂 Provider，故允许取不到上下文 */
export function useOptionalCedarExport(): CedarExportContextValue | null {
  return useContext(CedarExportContext);
}

function useCedarExport(): CedarExportContextValue {
  const ctx = useContext(CedarExportContext);
  if (!ctx) throw new Error('CedarExportButton / CedarExportStatus 须放在 CedarExportProvider 内');
  return ctx;
}

export function CedarExportProvider({ policyId, labels, hasExecutableVersion, versionsHref, children }: CedarExportProviderProps & { children: ReactNode }) {
  const [state, setState] = useState<ExportState>({ kind: 'idle' });

  const handleExport = useCallback(async (functionName?: string) => {
    setState({ kind: 'busy' });
    try {
      setState(await runExport(policyId, labels, functionName));
    } catch {
      setState({ kind: 'error', message: labels.failed });
    }
  }, [policyId, labels]);

  const value = useMemo(
    () => ({ labels, hasExecutableVersion, versionsHref, state, handleExport }),
    [labels, hasExecutableVersion, versionsHref, state, handleExport],
  );
  return <CedarExportContext.Provider value={value}>{children}</CedarExportContext.Provider>;
}

/** 页头操作组里的按钮：样式与「编辑」一致（次级按钮）。 */
export function CedarExportButton() {
  const { labels, hasExecutableVersion, state, handleExport } = useCedarExport();
  const busy = state.kind === 'busy';
  return (
    <button
      type="button"
      onClick={() => handleExport()}
      disabled={busy || !hasExecutableVersion}
      aria-label={labels.button}
      aria-busy={busy || undefined}
      aria-describedby={hasExecutableVersion ? undefined : NO_VERSION_HINT_ID}
      data-testid="cedar-export-button"
      className="inline-flex items-center rounded-md bg-bg px-3 py-2 text-sm font-semibold text-fg shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
    >
      {/* 两段文案叠在同一格里、只显示其一：按钮宽度取两者较宽者，导出中切换文案时同组按钮不移位 */}
      <span className="grid">
        <span className={`col-start-1 row-start-1 ${busy ? 'invisible' : ''}`}>{labels.button}</span>
        <span className={`col-start-1 row-start-1 ${busy ? '' : 'invisible'}`} aria-hidden="true">{labels.exporting}</span>
      </span>
    </button>
  );
}

/**
 * 页头下方的状态区：始终挂载且不隐藏（读屏只播报已在无障碍树里的 live region 的变化），空时高度为 0、无外边距。
 * sm 起各条消息靠右、宽度不超过 max-w-xl，紧贴上方操作组（短消息右对齐，多行诊断仍左对齐便于阅读）；消息出现只把下方内容往下推，页头里的操作不受影响。
 */
export function CedarExportStatus({ className = '' }: { className?: string }) {
  const { labels, hasExecutableVersion, versionsHref, state, handleExport } = useCedarExport();
  const busy = state.kind === 'busy';
  return (
    <div
      aria-live="polite"
      data-testid="cedar-export-status"
      className={`flex max-w-full flex-col gap-2 sm:items-end sm:[&>*]:max-w-xl [&:not(:empty)]:-mt-3 [&:not(:empty)]:mb-6 ${className}`}
    >
      {!hasExecutableVersion && (
        <p id={NO_VERSION_HINT_ID} className="text-sm text-fg-muted sm:text-right">
          {labels.noExecutableVersion}
          <a href={versionsHref} className="ml-2 font-medium text-primary hover:text-primary-hover">
            {labels.versionsLink} →
          </a>
        </p>
      )}
      {state.kind === 'chooseRule' && (
        <RuleChooser candidates={state.candidates} labels={labels} busy={busy} onExport={handleExport} />
      )}
      <ExportResult state={state} labels={labels} />
    </div>
  );
}
