'use client';

/*
 * 策略详情页的策略包导出（ADR 0059 P2，T19）。
 *
 * 与 Cedar 导出同样分成两处、共享一份状态（PackageExportProvider）：
 * - 「导出」菜单里的 JRE / Node 包选项（policy-export-menu）调 startExport / showReasons；
 * - PackageExportStatus：页头下方始终挂载的 aria-live 状态区，显示下载结果（zip SHA-256 可复制，ADR §6.2）、
 *   无签名提示、不可导出的诊断、入口选择与错误。空时不占高度。
 * 下载走 POST /api/policies/[id]/export/package：zip 字节按 Content-Disposition 的文件名保存，
 * SHA-256 取 X-Aster-Package-Sha256（aster-api 审计链记录的同一值）。失败文案按状态与稳定错误码在客户端本地化，
 * 不显示服务端原文（#688）；诊断按错误码给出本地化原因，英文原文作为补充保留。
 */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { actionErrorCode } from '@/lib/api/error-envelope';
import { packageFilename } from '@/lib/package-filename';
import { safeDiagnostics } from '@/lib/package-diagnostics';
import type { PackageExportTarget, PackageExportUiLocale, PolicyDiagnostic } from '@/services/policy/policy-api';
import type { PackageExportMenuState } from '@/lib/package-export-state';

export interface PackageExportLabels {
  menu: string;
  cedarItem: string;
  cedarHint: string;
  jreItem: string;
  jreHint: string;
  nodeItem: string;
  nodeHint: string;
  exporting: string;
  /** 含 {sha256} 占位符的原始文案 */
  downloaded: string;
  unsigned: string;
  notExportable: string;
  showReasons: string;
  chooseEntry: string;
  exportEntry: string;
  planRequired: string;
  busy: string;
  unavailable: string;
  failed: string;
  noExecutableVersion: string;
  copy: string;
  copied: string;
  /** 按诊断码（E730–E739）的可读原因；other 为未登记码的兜底 */
  reasons: Record<string, string>;
}

export type PackageExportState =
  | { kind: 'idle' }
  | { kind: 'busy'; target: PackageExportTarget }
  | { kind: 'downloaded'; sha256: string; signed: boolean }
  | { kind: 'refused'; diagnostics: PolicyDiagnostic[] }
  | { kind: 'chooseEntry'; target: PackageExportTarget; candidates: string[] }
  | { kind: 'error'; message: string };

const UI_LOCALES: readonly PackageExportUiLocale[] = ['en', 'zh', 'de', 'hi'];

function uiLocaleOf(locale: string): PackageExportUiLocale {
  const short = locale.slice(0, 2).toLowerCase();
  return (UI_LOCALES as readonly string[]).includes(short) ? (short as PackageExportUiLocale) : 'en';
}

function downloadBlob(name: string, bytes: ArrayBuffer): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  'export_signing_unavailable',
  'export_signing_kid_unanchored',
  'export_runtime_unavailable',
  'export_runtime_skew',
]);

/** 非 2xx 的响应 → 面板状态：按状态码与稳定错误码本地化 */
async function failureState(res: Response, target: PackageExportTarget, labels: PackageExportLabels): Promise<PackageExportState> {
  if (res.status === 409) return { kind: 'error', message: labels.noExecutableVersion };
  const body: unknown = await res.json().catch(() => null);
  const code = actionErrorCode(body);
  if (res.status === 400 && code === 'entry_required') {
    const raw = (body as { entryCandidates?: unknown }).entryCandidates;
    const candidates = Array.isArray(raw) ? raw.filter((e): e is string => typeof e === 'string') : [];
    if (candidates.length > 0) return { kind: 'chooseEntry', target, candidates };
  }
  if (res.status === 403 && code === 'policy_export_requires_plan') return { kind: 'error', message: labels.planRequired };
  if (res.status === 429 || code === 'package_export_busy') return { kind: 'error', message: labels.busy };
  if (code && UNAVAILABLE_CODES.has(code)) return { kind: 'error', message: labels.unavailable };
  return { kind: 'error', message: labels.failed };
}

async function runExport(
  policyId: string,
  target: PackageExportTarget,
  uiLocale: PackageExportUiLocale,
  labels: PackageExportLabels,
  entry?: string,
): Promise<PackageExportState> {
  const res = await fetch(`/api/policies/${policyId}/export/package`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, uiLocale, ...(entry ? { entry } : {}) }),
  });
  if (!res.ok) return failureState(res, target, labels);
  if ((res.headers.get('Content-Type') ?? '').startsWith('application/zip')) {
    const sha256 = res.headers.get('X-Aster-Package-Sha256') ?? '';
    downloadBlob(packageFilename(res.headers.get('Content-Disposition')), await res.arrayBuffer());
    return { kind: 'downloaded', sha256, signed: res.headers.get('X-Aster-Package-Signed') === 'true' };
  }
  const data = (await res.json().catch(() => null)) as { exportable?: unknown; diagnostics?: unknown } | null;
  if (data?.exportable === false) {
    return { kind: 'refused', diagnostics: safeDiagnostics(data.diagnostics) };
  }
  return { kind: 'error', message: labels.failed };
}

interface PackageExportContextValue {
  labels: PackageExportLabels;
  packages: PackageExportMenuState;
  state: PackageExportState;
  /** 菜单选中可导出（或未知）的包项：需选入口时先进入选择，否则直接导出 */
  startExport: (target: PackageExportTarget) => void;
  /** 菜单选中不可导出的包项：在状态区列出 check 已给出的诊断 */
  showReasons: (target: PackageExportTarget) => void;
  exportEntry: (target: PackageExportTarget, entry: string) => void;
}

const PackageExportContext = createContext<PackageExportContextValue | null>(null);

/** 菜单在没有包选项时也会渲染（只剩 Cedar），故允许取不到上下文 */
export function useOptionalPackageExport(): PackageExportContextValue | null {
  return useContext(PackageExportContext);
}

interface ProviderProps {
  policyId: string;
  locale: string;
  labels: PackageExportLabels;
  packages: PackageExportMenuState;
  children: ReactNode;
}

export function PackageExportProvider({ policyId, locale, labels, packages, children }: ProviderProps) {
  const [state, setState] = useState<PackageExportState>({ kind: 'idle' });
  const uiLocale = uiLocaleOf(locale);

  const exportEntry = useCallback(async (target: PackageExportTarget, entry?: string) => {
    setState({ kind: 'busy', target });
    try {
      setState(await runExport(policyId, target, uiLocale, labels, entry));
    } catch {
      setState({ kind: 'error', message: labels.failed });
    }
  }, [policyId, uiLocale, labels]);

  const startExport = useCallback((target: PackageExportTarget) => {
    if (packages.entryRequired) setState({ kind: 'chooseEntry', target, candidates: packages.entryCandidates });
    else void exportEntry(target);
  }, [packages, exportEntry]);

  const showReasons = useCallback((target: PackageExportTarget) => {
    setState({ kind: 'refused', diagnostics: packages.diagnostics[target] });
  }, [packages]);

  const value = useMemo(
    () => ({ labels, packages, state, startExport, showReasons, exportEntry: (t: PackageExportTarget, e: string) => void exportEntry(t, e) }),
    [labels, packages, state, startExport, showReasons, exportEntry],
  );
  return <PackageExportContext.Provider value={value}>{children}</PackageExportContext.Provider>;
}

/** 诊断列表：码、行列与本地化原因；未登记的码显示兜底原因，英文原文作为补充（lang="en"）。 */
export function PackageDiagnosticList({ diagnostics, reasons }: { diagnostics: PolicyDiagnostic[]; reasons: Record<string, string> }) {
  return (
    <ul className="mt-2 space-y-2 text-sm">
      {diagnostics.map((d, i) => (
        <li key={`${d.code ?? ''}-${d.startLine}-${d.startColumn}-${i}`} className="text-red-700">
          <span className="font-mono font-semibold">{d.code ?? '—'}</span>
          {d.startLine > 0 && <span className="ml-2 font-mono">{`${d.startLine}:${d.startColumn}`}</span>}
          <span className="ml-2">{(d.code && reasons[d.code]) || reasons.other}</span>
          {d.message && <span lang="en" className="mt-0.5 block break-words text-xs text-fg-muted">{d.message}</span>}
        </li>
      ))}
    </ul>
  );
}

function CopyButton({ text, labels }: { text: string; labels: PackageExportLabels }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板不可用（权限 / 非安全上下文）：哈希仍可手动选中复制
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      data-testid="package-export-copy"
      className="inline-flex min-h-11 items-center rounded-md bg-bg px-3 text-sm font-semibold text-fg shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-bg-subtle sm:min-h-0 sm:py-1"
    >
      {/* 两段文案叠放，切换「已复制」时按钮宽度不变 */}
      <span className="grid">
        <span className={`col-start-1 row-start-1 ${copied ? 'invisible' : ''}`}>{labels.copy}</span>
        <span className={`col-start-1 row-start-1 ${copied ? '' : 'invisible'}`} aria-hidden={!copied}>{labels.copied}</span>
      </span>
    </button>
  );
}

function EntryChooser({ target, candidates, labels, onExport }: {
  target: PackageExportTarget;
  candidates: string[];
  labels: PackageExportLabels;
  onExport: (target: PackageExportTarget, entry: string) => void;
}) {
  const [chosen, setChosen] = useState(candidates[0]!);
  const selectId = useId();
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <label htmlFor={selectId} className="text-fg">{labels.chooseEntry}</label>
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
        onClick={() => onExport(target, chosen)}
        className="inline-flex items-center rounded-md bg-primary px-3 py-1 text-sm font-semibold text-primary-fg hover:bg-primary-hover"
      >
        {labels.exportEntry}
      </button>
    </div>
  );
}

function Result({ state, labels }: { state: PackageExportState; labels: PackageExportLabels }) {
  if (state.kind === 'downloaded') {
    const [before, after = ''] = labels.downloaded.split('{sha256}');
    return (
      <div className="flex flex-col gap-2 text-sm sm:items-end" data-testid="package-export-downloaded">
        <p className="text-green-700 sm:text-right">
          {before}
          <code className="break-all font-mono text-fg" data-testid="package-export-sha256">{state.sha256}</code>
          {after}
        </p>
        <CopyButton text={state.sha256} labels={labels} />
        {!state.signed && <p className="text-fg-muted sm:text-right" data-testid="package-export-unsigned">{labels.unsigned}</p>}
      </div>
    );
  }
  if (state.kind === 'error') return <p className="text-sm text-red-700" role="alert">{state.message}</p>;
  if (state.kind !== 'refused') return null;
  return (
    <div role="alert" data-testid="package-export-refused">
      <p className="text-sm font-medium text-red-700">{labels.notExportable}</p>
      <PackageDiagnosticList diagnostics={state.diagnostics} reasons={labels.reasons} />
    </div>
  );
}

/** 页头下方的状态区：始终挂载（读屏只播报已在无障碍树里的 live region 的变化），空时高度为 0。 */
export function PackageExportStatus() {
  const ctx = useOptionalPackageExport();
  if (!ctx) return null;
  const { labels, state, exportEntry } = ctx;
  return (
    <div
      aria-live="polite"
      data-testid="package-export-status"
      className="flex max-w-full flex-col gap-2 sm:items-end sm:[&>*]:max-w-xl [&:not(:empty)]:-mt-3 [&:not(:empty)]:mb-6"
    >
      {state.kind === 'chooseEntry' && (
        // 换 target 或候选集合时重新挂载，选择回到首个候选，不会提交列表外的旧值
        <EntryChooser
          key={`${state.target}:${state.candidates.join('\u0000')}`}
          target={state.target}
          candidates={state.candidates}
          labels={labels}
          onExport={exportEntry}
        />
      )}
      <Result state={state} labels={labels} />
    </div>
  );
}
