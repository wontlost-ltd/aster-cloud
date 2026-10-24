'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, ConfirmDialog, Container, PageHeader } from '@/components/ui';

type Run = { runId?: string; id?: string; toolchainId?: string; status?: string; checked?: number; total?: number; invalid_count?: number };
type Invalid = { versionId?: string; version_id?: string; tenantId?: string; tenant_id?: string; toolchainId?: string; diagnostics?: Array<{ code?: string; message?: string }> };
const RECENT_RUN_KEY = 'aster.admin.revalidation.recentRunId';

export function RevalidationContent() {
  const t = useTranslations('admin.revalidation');
  const [run, setRun] = useState<Run | null>(null);
  const [invalid, setInvalid] = useState<Invalid[]>([]);
  const [message, setMessage] = useState('');
  // 启动确认走设计系统 ConfirmDialog，不用浏览器原生 confirm()（无法套样式、不随主题）。
  const [confirmOpen, setConfirmOpen] = useState(false);
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
  async function start() {
    setStarting(true);
    try {
      const response = await fetch('/api/admin/revalidation/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'all' }) });
      if (response.status === 409) { setMessage(t('alreadyRunning')); return; }
      if (!response.ok) { setMessage(t('startFailed', { status: response.status })); return; }
      const started = await response.json();
      const runId = started.runId ?? started.id;
      if (runId) window.localStorage.setItem(RECENT_RUN_KEY, runId);
      setRun(started);
      setMessage(t('started'));
      await load();
    } catch {
      // 网络层抛错（无 HTTP 状态）也要给出提示并收口对话框，不能让遮罩停在 loading。
      setMessage(t('startFailed', { status: 0 }));
    } finally {
      setStarting(false);
      setConfirmOpen(false);
    }
  }
  return <Container size="xl" className="py-6 sm:py-10">
    <PageHeader title={t('title')} />
    <section className="my-6 rounded-lg border p-4">
      {(run?.toolchainId || invalid[0]?.toolchainId) && <p>{t('toolchain')}: {run?.toolchainId ?? invalid[0]?.toolchainId}</p>}
      <p>{t('recentRun')}: {run?.status ?? t('noRun')}　{t('progress')}: {run?.checked ?? 0}/{run?.total ?? 0}　{t('needsRepair')}: {run?.invalid_count ?? invalid.length}</p>
      <Button className="mt-3" onClick={() => setConfirmOpen(true)}>{t('startButton')}</Button>
      {message && <p role="status" className="mt-2">{message}</p>}
    </section>
    <h2 className="mb-3 text-lg font-semibold">{t('invalidVersions')}</h2>
    <div className="overflow-x-auto"><table className="w-full border-collapse text-left"><thead><tr><th className="p-2">{t('version')}</th><th className="p-2">{t('tenant')}</th><th className="p-2">{t('firstDiagnostic')}</th></tr></thead>
      <tbody>{invalid.map((row, index) => <tr key={row.versionId ?? row.version_id ?? index} className="border-t"><td className="p-2">{row.versionId ?? row.version_id}</td><td className="p-2">{row.tenantId ?? row.tenant_id ?? '—'}</td><td className="p-2">{row.diagnostics?.[0] ? `${row.diagnostics[0].code ?? ''} ${row.diagnostics[0].message ?? ''}` : '—'}</td></tr>)}
      {!invalid.length && <tr><td className="p-2" colSpan={3}>{t('noInvalidVersions')}</td></tr>}</tbody></table></div>
    <ConfirmDialog
      isOpen={confirmOpen}
      title={t('startButton')}
      description={t('confirmStart')}
      confirmLabel={t('startButton')}
      variant="warning"
      isLoading={starting}
      onConfirm={start}
      onCancel={() => !starting && setConfirmOpen(false)}
    />
  </Container>;
}
