'use client';

/*
 * 策略详情页「导出为 Cedar」面板（ADR 0047 §6）。
 * 调所有者路由导出可执行版本：可导出时原样下载 <module>.cedar 与 <module>.cedarschema.json（模块名取编译器给出的
 * moduleName），并报告与 Cedar 比对过的探针数；不可导出时列出诊断；无可执行版本时提示先批准。文案由服务端页面预渲染传入。
 */
import { useCallback, useState } from 'react';
import type { PolicyCedarExportResponse, PolicyDiagnostic } from '@/services/policy/policy-api';

export interface CedarExportLabels {
  button: string;
  exporting: string;
  /** 含 {count} 占位符的原始文案，按探针数在客户端替换 */
  verified: string;
  notExportable: string;
  failed: string;
  noExecutableVersion: string;
}

interface CedarExportPanelProps {
  policyId: string;
  labels: CedarExportLabels;
}

type ExportState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'verified'; count: number }
  | { kind: 'notExportable'; diagnostics: PolicyDiagnostic[] }
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

// 409 为无可执行版本，提示先批准；503 为服务端导出并发已满，显示服务端消息提示稍后重试；其余失败统一显示 failed
async function failureMessage(res: Response, labels: CedarExportLabels): Promise<string> {
  if (res.status === 409) return labels.noExecutableVersion;
  if (res.status !== 503) return labels.failed;
  const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
  return typeof body?.message === 'string' && body.message ? body.message : labels.failed;
}

async function runExport(policyId: string, labels: CedarExportLabels): Promise<ExportState> {
  const res = await fetch(`/api/policies/${policyId}/export/cedar`, { method: 'POST' });
  if (!res.ok) return { kind: 'error', message: await failureMessage(res, labels) };
  const data = (await res.json()) as PolicyCedarExportResponse;
  if (!data.exportable || data.policies == null || data.schemaText == null) {
    return { kind: 'notExportable', diagnostics: data.diagnostics ?? [] };
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
    return <p className="mt-2 text-sm text-green-700">{labels.verified.replace('{count}', String(state.count))}</p>;
  }
  if (state.kind === 'error') {
    return <p className="mt-2 text-sm text-red-700" role="alert">{state.message}</p>;
  }
  if (state.kind !== 'notExportable') return null;
  return (
    <div className="mt-2" role="alert">
      <p className="text-sm font-medium text-red-700">{labels.notExportable}</p>
      <DiagnosticList diagnostics={state.diagnostics} />
    </div>
  );
}

export function CedarExportPanel({ policyId, labels }: CedarExportPanelProps) {
  const [state, setState] = useState<ExportState>({ kind: 'idle' });
  const busy = state.kind === 'busy';

  const handleExport = useCallback(async () => {
    setState({ kind: 'busy' });
    try {
      setState(await runExport(policyId, labels));
    } catch {
      setState({ kind: 'error', message: labels.failed });
    }
  }, [policyId, labels]);

  return (
    <div className="mb-6">
      <button
        type="button"
        onClick={handleExport}
        disabled={busy}
        aria-label={labels.button}
        className="inline-flex items-center rounded-md bg-bg px-3 py-2 text-sm font-semibold text-fg shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? labels.exporting : labels.button}
      </button>
      <ExportResult state={state} labels={labels} />
    </div>
  );
}
