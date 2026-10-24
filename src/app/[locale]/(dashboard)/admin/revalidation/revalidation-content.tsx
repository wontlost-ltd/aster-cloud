'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, ConfirmDialog, Container, Input, PageHeader, Select } from '@/components/ui';

type Run = { runId?: string; id?: string; toolchainId?: string; status?: string; checked?: number; total?: number; invalid_count?: number; invalidCount?: number; mode?: string; scope?: string; scopeTenant?: string | null; triggeredBy?: string | null };
type Invalid = { versionId?: string; version_id?: string; tenantId?: string; tenant_id?: string; toolchainId?: string; advisory?: boolean; diagnostics?: Array<{ code?: string; message?: string }> };
type Preview = { toolchainId: string; total: number; batchSize: number; intervalSeconds: number; estimatedMinutes: number };
type Scope = 'all' | 'tenant';
type Mode = 'enforce' | 'report';
/** 一次发起的参数快照：预估、确认文案与最终 POST 都读它，不读可能已被改动的表单。 */
type StartParams = { scope: Scope; tenantId: string; mode: Mode };
/** 待确认的发起：参数快照 + 对应预估；非 null 即对话框打开。 */
type Pending = { params: StartParams; preview: Preview };
const RECENT_RUN_KEY = 'aster.admin.revalidation.recentRunId';

export function RevalidationContent() {
  const t = useTranslations('admin.revalidation');
  const [run, setRun] = useState<Run | null>(null);
  const [invalid, setInvalid] = useState<Invalid[]>([]);
  const [message, setMessage] = useState('');
  // 发起参数：范围（全平台 / 单租户）与模式（enforce 立即生效 / report 只报告）。
  const [scope, setScope] = useState<Scope>('all');
  const [tenantId, setTenantId] = useState('');
  const [mode, setMode] = useState<Mode>('enforce');
  // 确认前先取预估（扫描数量、预计耗时），让管理员看到影响面再确认；走设计系统 ConfirmDialog。
  const [pending, setPending] = useState<Pending | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [starting, setStarting] = useState(false);
  const load = useCallback(async () => {
    const response = await fetch('/api/admin/revalidation/invalid?page=0&size=50', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    setInvalid(data.items ?? data.invalid ?? []);
    const savedRunId = window.localStorage.getItem(RECENT_RUN_KEY);
    if (savedRunId) {
      const runResponse = await fetch(`/api/admin/revalidation/runs/${encodeURIComponent(savedRunId)}`, { cache: 'no-store' });
      if (runResponse.ok) setRun(await runResponse.json());
    } else setRun(null);
  }, []);
  useEffect(() => {
    // 初始加载由 effect 启动，状态更新发生在网络响应回调中。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  const tenantMissing = scope === 'tenant' && tenantId.trim() === '';
  const busy = previewing || pending !== null;
  const scopeQuery = (p: StartParams) => p.scope === 'tenant' ? `scope=tenant&tenantId=${encodeURIComponent(p.tenantId)}` : 'scope=all';
  async function openPreview() {
    const params: StartParams = { scope, tenantId: tenantId.trim(), mode };
    setPreviewing(true);
    try {
      const response = await fetch(`/api/admin/revalidation/preview?${scopeQuery(params)}`, { cache: 'no-store' });
      if (!response.ok) { setMessage(t('previewFailed', { status: response.status })); return; }
      setPending({ params, preview: await response.json() });
    } catch {
      setMessage(t('previewFailed', { status: 0 }));
    } finally {
      setPreviewing(false);
    }
  }
  async function start() {
    if (!pending) return;
    const { params } = pending;
    setStarting(true);
    try {
      const body = { scope: params.scope, mode: params.mode, ...(params.scope === 'tenant' ? { tenantId: params.tenantId } : {}) };
      const response = await fetch('/api/admin/revalidation/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (response.status === 409) { setMessage(t('alreadyRunning')); return; }
      if (!response.ok) { setMessage(t('startFailed', { status: response.status })); return; }
      const started = await response.json();
      const runId = started.runId ?? started.id;
      if (runId) window.localStorage.setItem(RECENT_RUN_KEY, runId);
      setRun(started);
      setMessage(params.mode === 'report' ? t('startedReport') : t('started'));
      await load();
    } catch {
      // 网络层抛错（无 HTTP 状态）也要给出提示并收口对话框，不能让遮罩停在 loading。
      setMessage(t('startFailed', { status: 0 }));
    } finally {
      setStarting(false);
      setPending(null);
    }
  }
  const invalidCount = run?.invalidCount ?? run?.invalid_count ?? invalid.length;
  return <Container size="xl" className="py-6 sm:py-10">
    <PageHeader title={t('title')} />
    <section className="my-6 rounded-lg border p-4">
      <p className="mb-3 rounded-md bg-info-subtle p-3 text-sm text-fg-muted">{t('scopeExplanation')}</p>
      {(run?.toolchainId || invalid[0]?.toolchainId) && <p>{t('toolchain')}: {run?.toolchainId ?? invalid[0]?.toolchainId}</p>}
      <p>{t('recentRun')}: {run?.status ?? t('noRun')}　{t('progress')}: {run?.checked ?? 0}/{run?.total ?? 0}　{t('needsRepair')}: {invalidCount}
        {run?.mode && <>　{t('modeLabel')}: {run.mode === 'report' ? t('modeReportBadge') : t('modeEnforceBadge')}</>}
        {run?.triggeredBy && <>　{t('triggeredBy')}: {run.triggeredBy}</>}</p>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">{t('scopeLabel')}
          <Select value={scope} disabled={busy} onChange={(e) => setScope(e.target.value as Scope)}>
            <option value="all">{t('scopeAll')}</option>
            <option value="tenant">{t('scopeTenant')}</option>
          </Select>
        </label>
        {scope === 'tenant' && <label className="flex flex-col gap-1 text-sm">{t('tenantIdLabel')}
          <Input value={tenantId} disabled={busy} onChange={(e) => setTenantId(e.target.value)} placeholder={t('tenantIdPlaceholder')} />
        </label>}
        <label className="flex flex-col gap-1 text-sm">{t('modeLabel')}
          <Select value={mode} disabled={busy} onChange={(e) => setMode(e.target.value as Mode)}>
            <option value="enforce">{t('modeEnforce')}</option>
            <option value="report">{t('modeReport')}</option>
          </Select>
        </label>
        <Button onClick={openPreview} disabled={busy || tenantMissing}>{t('startButton')}</Button>
      </div>
      <p className="mt-2 text-sm text-fg-muted">{mode === 'report' ? t('modeReportHint') : t('modeEnforceHint')}</p>
      {message && <p role="status" className="mt-2">{message}</p>}
    </section>
    <h2 className="mb-3 text-lg font-semibold">{t('invalidVersions')}</h2>
    <div className="overflow-x-auto"><table className="w-full border-collapse text-left"><thead><tr><th className="p-2">{t('version')}</th><th className="p-2">{t('tenant')}</th><th className="p-2">{t('verdictKind')}</th><th className="p-2">{t('firstDiagnostic')}</th></tr></thead>
      <tbody>{invalid.map((row, index) => <tr key={row.versionId ?? row.version_id ?? index} className="border-t"><td className="p-2">{row.versionId ?? row.version_id}</td><td className="p-2">{row.tenantId ?? row.tenant_id ?? '—'}</td><td className="p-2">{row.advisory ? t('verdictAdvisory') : t('verdictBinding')}</td><td className="p-2">{row.diagnostics?.[0] ? `${row.diagnostics[0].code ?? ''} ${row.diagnostics[0].message ?? ''}` : '—'}</td></tr>)}
      {!invalid.length && <tr><td className="p-2" colSpan={4}>{t('noInvalidVersions')}</td></tr>}</tbody></table></div>
    <ConfirmDialog
      isOpen={pending !== null}
      title={t('startButton')}
      description={pending ? t(pending.params.mode === 'report' ? 'confirmReport' : 'confirmEnforce', {
        total: pending.preview.total, minutes: pending.preview.estimatedMinutes,
        scope: pending.params.scope === 'tenant' ? pending.params.tenantId : t('scopeAll'),
      }) : ''}
      confirmLabel={t('startButton')}
      variant={pending?.params.mode === 'report' ? 'info' : 'warning'}
      isLoading={starting}
      onConfirm={start}
      onCancel={() => !starting && setPending(null)}
    />
  </Container>;
}
