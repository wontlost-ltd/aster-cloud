'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Container, PageHeader } from '@/components/ui';
import { ToolchainId } from '@/components/admin/toolchain-id';

interface ReportRow {
  id: string;
  policyVersionRowId: string;
  status: 'PASS' | 'FAIL_REGRESSION' | 'FAIL_INSUFFICIENT_COVERAGE' | 'NON_REPLAYABLE';
  comparisonMode: string;
  caseCount: number;
  runnableCaseCount: number;
  passedCaseCount: number;
  failedCaseCount: number;
  nonReplayableCaseCount: number;
  reportHash: string;
  currentRuntimeToolchainId: string | null;
  createdAt: string;
  // ★Item 2/4 F：签字资格（独立于 status）。list API 返回的是**派生**值（deriveReportSignabilityDetail），
  // 已归一为**真二值** 'SIGNABLE' | 'UNSIGNABLE'（provenance-only 报告不再返回 LEGACY 枚举——Codex 复审致命 3）。
  // 具体不可签字维度看 unsignableReasons。旧后端/异常缺失时前端应 fail-closed（见渲染逻辑，不显绿色）。
  signability: 'SIGNABLE' | 'UNSIGNABLE';
  unsignableLegacyCases: number | null;
  signablePass: boolean;
  // ★F1（独立审查）：列表是**声明态**（未重核 golden），verified=false——UI 只显「声明可签字」弱信号，
  // 强绿灯（已核验）以单报告详情 / ?verify=1 为准。旧后端缺此字段视为 false（fail-closed 弱信号）。
  verified?: boolean;
  // ★Item 4 F：完整不可签字原因（含 TOOLCHAIN_PROVENANCE_UNVERIFIED）。UI 据此显各维度 badge。
  unsignableReasons?: string[];
  // ★S1（层5）：是否有活跃已批准升级 manifest。显「已批准升级」badge——诚实：这是层5 证据，**不**解锁签字
  //（报告仍 UNSIGNABLE，provenance 未验证）。旧后端缺此字段视为 false。
  transitionVerified?: boolean;
}

interface CaseRow {
  id: string;
  policyVersionRowId: string;
  functionName: string;
  locale: string;
  expectedDecision: string | null;
  sourceKind: string;
  coverageTags: string[];
  replayLimited: boolean;
  canonicalInputHash: string;
  createdAt: string;
}

const STATUS_STYLES: Record<ReportRow['status'], string> = {
  PASS: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  FAIL_REGRESSION: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  FAIL_INSUFFICIENT_COVERAGE: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
  NON_REPLAYABLE: 'bg-bg-muted text-fg-muted',
};

export function RuleRegressionContent() {
  const t = useTranslations('ruleRegression');
  const [policyId, setPolicyId] = useState('');
  const [versionRow, setVersionRow] = useState('');
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const statusLabel = useCallback(
    (s: ReportRow['status']) => {
      switch (s) {
        case 'PASS':
          return t('statusPass');
        case 'FAIL_REGRESSION':
          return t('statusFailRegression');
        case 'FAIL_INSUFFICIENT_COVERAGE':
          return t('statusFailCoverage');
        case 'NON_REPLAYABLE':
          return t('statusNonReplayable');
      }
    },
    [t]
  );

  const load = useCallback(async () => {
    if (!policyId.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ policyId: policyId.trim() });
      if (versionRow.trim()) qs.set('policyVersionRowId', versionRow.trim());
      const res = await fetch(`/api/admin/rule-regression?${qs.toString()}`);
      if (!res.ok) {
        setError(t('loadError'));
        setReports([]);
        setCases([]);
        return;
      }
      const data = (await res.json()) as { reports: ReportRow[]; cases: CaseRow[] };
      setReports(data.reports ?? []);
      setCases(data.cases ?? []);
      setLoaded(true);
    } catch {
      setError(t('loadError'));
    } finally {
      setLoading(false);
    }
  }, [policyId, versionRow, t]);

  return (
    <Container size="xl" className="py-6 sm:py-10">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        className="mb-6"
      />

      <p className="mb-4 rounded-md border border-border bg-bg-muted/40 p-3 text-sm text-fg-muted">
        {t('comparisonNote')}
      </p>

      <section className="mb-8 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wider text-fg-muted">{t('policyIdLabel')}</span>
          <input
            value={policyId}
            onChange={(e) => setPolicyId(e.target.value)}
            placeholder={t('policyIdPlaceholder')}
            className="w-64 rounded-md border border-border bg-bg px-3 py-2 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wider text-fg-muted">{t('versionLabel')}</span>
          <input
            value={versionRow}
            onChange={(e) => setVersionRow(e.target.value)}
            className="w-64 rounded-md border border-border bg-bg px-3 py-2 text-sm"
          />
        </label>
        <button
          onClick={load}
          disabled={loading || !policyId.trim()}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-fg disabled:opacity-50"
        >
          {loading ? t('loading') : t('load')}
        </button>
      </section>

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      {loaded && (
        <>
          <section className="mb-10">
            <h2 className="mb-3 text-lg font-semibold">{t('reportsHeading')}</h2>
            {reports.length === 0 ? (
              <p className="text-sm text-fg-muted">{t('noReports')}</p>
            ) : (
              <div tabIndex={0} role="region" aria-label={t('reportsHeading')} data-scroll-region className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-bg-muted/50 text-left text-xs uppercase tracking-wider text-fg-muted">
                    <tr>
                      <th className="px-3 py-2">{t('colStatus')}</th>
                      <th className="px-3 py-2">{t('colVersion')}</th>
                      <th className="px-3 py-2 text-right">{t('colCases')}</th>
                      <th className="px-3 py-2 text-right">{t('colRunnable')}</th>
                      <th className="px-3 py-2 text-right">{t('colPassed')}</th>
                      <th className="px-3 py-2 text-right">{t('colFailed')}</th>
                      <th className="px-3 py-2 text-right">{t('colNonReplayable')}</th>
                      <th className="px-3 py-2">{t('colToolchain')}</th>
                      <th className="px-3 py-2">{t('colReportHash')}</th>
                      <th className="px-3 py-2">{t('colCreated')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reports.map((r) => (
                      <tr key={r.id} className="border-t border-border">
                        <td className="px-3 py-2">
                          <div className="flex flex-col gap-1">
                            {/* 执行结果 badge。★fail-closed：status=PASS 只有 signablePass===true 才用绿色；否则
                                （不可签字或字段缺失/未知）一律中性，绝不误显「绿色可签字」。 */}
                            <span
                              className={`rounded px-2 py-0.5 text-xs font-medium ${
                                r.status === 'PASS' && r.signablePass !== true
                                  ? 'bg-bg-muted text-fg-muted'
                                  : STATUS_STYLES[r.status]
                              }`}
                            >
                              {statusLabel(r.status)}
                            </span>
                            {/* 签字资格 badge（独立轴）。legacy 维度（含 case-hash/m1.0 弱绑定）。 */}
                            {r.unsignableReasons?.includes('LEGACY_CASE_HASH_VERSION') && (
                              <span
                                className="rounded px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                                title={t('signabilityUnsignableHint')}
                              >
                                {t('signabilityUnsignable')}
                                {r.unsignableLegacyCases ? ` (${r.unsignableLegacyCases})` : ''}
                              </span>
                            )}
                            {/* ★Item 4 F：toolchain provenance 未验证维度——声称跨升级安全但无 runtime provenance。 */}
                            {r.unsignableReasons?.includes('TOOLCHAIN_PROVENANCE_UNVERIFIED') && (
                              <span
                                className="rounded px-2 py-0.5 text-xs font-medium bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300"
                                title={t('signabilityProvenanceHint')}
                              >
                                {t('signabilityProvenance')}
                              </span>
                            )}
                            {/* ★S1（层5）：已批准升级 manifest badge——诚实：这是「批准了 X→Y 方向」的证据（层5），
                                **不**解锁签字（报告仍不可签字，provenance 层3 未验证）。故用中性 indigo，非绿色。 */}
                            {r.transitionVerified === true && (
                              <span
                                className="rounded px-2 py-0.5 text-xs font-medium bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300"
                                title={t('transitionApprovedHint')}
                              >
                                {t('transitionApproved')}
                              </span>
                            )}
                            {/* ★F1：列表是声明态（verified!==true）——可签字的报告标「声明可签字·待核验」，提醒 CCO
                                强绿灯（golden 已核验）以详情/verify 为准，不要凭列表直接签字。 */}
                            {r.status === 'PASS' && r.signablePass === true && r.verified !== true && (
                              <span
                                className="rounded px-2 py-0.5 text-xs font-medium bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300"
                                title={t('signabilityDeclaredHint')}
                              >
                                {t('signabilityDeclared')}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">{r.policyVersionRowId}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.caseCount}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.runnableCaseCount}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.passedCaseCount}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.failedCaseCount}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.nonReplayableCaseCount}</td>
                        <td className="min-w-[14rem] px-3 py-2 text-xs">
                          {/* 工具链标识整串无空格：在 `;` 处换行，不再把表格撑成一整行 */}
                          {r.currentRuntimeToolchainId ? <ToolchainId value={r.currentRuntimeToolchainId} /> : '—'}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">{r.reportHash.slice(0, 12)}…</td>
                        <td className="px-3 py-2 text-xs text-fg-muted">
                          {new Date(r.createdAt).toISOString().slice(0, 19).replace('T', ' ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold">{t('casesHeading')}</h2>
            <p className="mb-3 text-xs text-fg-muted">{t('replayLimitedNote')}</p>
            {cases.length === 0 ? (
              <p className="text-sm text-fg-muted">{t('noCases')}</p>
            ) : (
              <div tabIndex={0} role="region" aria-label={t('casesHeading')} data-scroll-region className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-bg-muted/50 text-left text-xs uppercase tracking-wider text-fg-muted">
                    <tr>
                      <th className="px-3 py-2">{t('colFunction')}</th>
                      <th className="px-3 py-2">{t('colLocale')}</th>
                      <th className="px-3 py-2">{t('colDecision')}</th>
                      <th className="px-3 py-2">{t('colSource')}</th>
                      <th className="px-3 py-2">{t('colTags')}</th>
                      <th className="px-3 py-2">{t('colReplayLimited')}</th>
                      <th className="px-3 py-2">{t('colVersion')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cases.map((c) => (
                      <tr key={c.id} className="border-t border-border">
                        <td className="px-3 py-2 font-mono text-xs">{c.functionName}</td>
                        <td className="px-3 py-2 text-xs">{c.locale}</td>
                        <td className="px-3 py-2 text-xs">{c.expectedDecision ?? '—'}</td>
                        <td className="px-3 py-2 text-xs">
                          {c.sourceKind === 'execution' ? t('sourceExecution') : t('sourceHandwritten')}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {Array.isArray(c.coverageTags) && c.coverageTags.length > 0 ? c.coverageTags.join(', ') : '—'}
                        </td>
                        <td className="px-3 py-2 text-xs">{c.replayLimited ? t('yes') : t('no')}</td>
                        <td className="px-3 py-2 font-mono text-xs">{c.policyVersionRowId}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </Container>
  );
}
