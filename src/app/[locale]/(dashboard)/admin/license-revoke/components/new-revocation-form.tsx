// NewRevocationForm — 新增 license revocation。
//
// 设计意图：
//   - licenseId + reason 是最小必填；notes/customerRef 保持内部支持上下文
//   - 真正 POST 前用 modal 二次确认，避免误撤销导致客户部署进入 read-only
//   - dryRun 走同一 payload，只改变 dryRun=true，便于 ops 预检 API 行为
//   - 打开确认框前先用 dryRun 预检 knownLicense：ID 不在已签发记录中时（可能是离线签发，
//     也可能是手误）在确认框与演练结果里醒目提示，但不阻止撤销

'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { RevocationReason } from '../revocation-content';

const LICENSE_ID_RE = /^lic_[A-Z0-9]{20,30}$/;
const REASONS: RevocationReason[] = [
  'non-payment',
  'security',
  'renewal-superseded',
  'contract-terminated',
  'fraud',
];

interface SubmitPayload {
  licenseId: string;
  reason: RevocationReason;
  notes?: string;
  customerRef?: string;
  dryRun?: boolean;
}

export function NewRevocationForm() {
  const t = useTranslations('admin.licenseRevoke');
  const router = useRouter();
  const [licenseId, setLicenseId] = useState('');
  const [reason, setReason] = useState<RevocationReason | ''>('');
  const [notes, setNotes] = useState('');
  const [customerRef, setCustomerRef] = useState('');
  const [dryRun, setDryRun] = useState(false);
  const [licenseError, setLicenseError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [pendingPayload, setPendingPayload] = useState<SubmitPayload | null>(null);
  const [submitState, setSubmitState] = useState<
    'idle' | 'loading' | 'success' | 'error'
  >('idle');
  const [message, setMessage] = useState('');
  // 预检 / 演练得到的 knownLicense：false = 不在已签发记录中；null = 未知（预检失败或尚未检查）。
  const [knownLicense, setKnownLicense] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  // codex 审查 Major-1：focus trap + Escape + open 时聚焦到 Cancel 按钮
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const submitButtonRef = useRef<HTMLButtonElement | null>(null);

  // 打开 modal 时聚焦 Cancel 按钮（破坏性操作默认低风险动作）
  useEffect(() => {
    if (pendingPayload) {
      cancelButtonRef.current?.focus();
    } else {
      submitButtonRef.current?.focus();
    }
  }, [pendingPayload]);

  // Escape 关闭 modal
  useEffect(() => {
    if (!pendingPayload) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setPendingPayload(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingPayload]);

  function buildPayload(): SubmitPayload | null {
    const normalizedLicenseId = licenseId.trim();
    const normalizedReason = reason;
    let valid = true;

    if (!LICENSE_ID_RE.test(normalizedLicenseId)) {
      setLicenseError(t('newForm.licenseIdInvalid'));
      valid = false;
    } else {
      setLicenseError(null);
    }

    if (!normalizedReason) {
      setReasonError(t('newForm.reasonRequired'));
      valid = false;
    } else {
      setReasonError(null);
    }

    if (!valid || !normalizedReason) return null;

    return {
      licenseId: normalizedLicenseId,
      reason: normalizedReason,
      notes: notes.trim() || undefined,
      customerRef: customerRef.trim() || undefined,
      dryRun,
    };
  }

  function postRevoke(payload: SubmitPayload) {
    return fetch('/api/admin/license-revoke', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = buildPayload();
    if (!payload) return;
    // 预检：同一 payload 以 dryRun 发出，只为拿到 knownLicense，不产生任何写入。
    // 预检失败不阻断流程（knownLicense 保持未知），真正的错误由确认后的请求报告。
    setChecking(true);
    setKnownLicense(null);
    try {
      const response = await postRevoke({ ...payload, dryRun: true });
      const body = (await response.json().catch(() => ({}))) as { knownLicense?: unknown };
      if (response.ok && typeof body.knownLicense === 'boolean') {
        setKnownLicense(body.knownLicense);
      }
    } catch {
      // 网络失败：保持未知
    } finally {
      setChecking(false);
    }
    setPendingPayload(payload);
  }

  async function confirmSubmit() {
    if (!pendingPayload) return;
    setSubmitState('loading');
    setMessage('');
    try {
      const response = await postRevoke(pendingPayload);
      const body = (await response.json().catch(() => ({}))) as {
        licenseId?: string;
        publishedVersion?: number | string;
        knownLicense?: boolean;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? response.statusText);
      if (typeof body.knownLicense === 'boolean') setKnownLicense(body.knownLicense);

      setSubmitState('success');
      setMessage(
        pendingPayload.dryRun
          ? t('newForm.dryRunSuccess', { licenseId: pendingPayload.licenseId })
          : t('newForm.success', {
              licenseId: body.licenseId ?? pendingPayload.licenseId,
              version: body.publishedVersion ?? '—',
            }),
      );
      setPendingPayload(null);
      if (!pendingPayload.dryRun) {
        setLicenseId('');
        setReason('');
        setNotes('');
        setCustomerRef('');
        setDryRun(false);
        router.refresh();
      }
    } catch (error) {
      setSubmitState('error');
      setMessage(
        t('newForm.error', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  return (
    <section
      aria-labelledby="new-revocation-heading"
      className="rounded-lg border border-border bg-bg p-5"
    >
      <h2
        id="new-revocation-heading"
        className="mb-4 text-base font-semibold text-fg"
      >
        {t('newForm.heading')}
      </h2>

      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label htmlFor="license-id" className="text-sm font-medium text-fg">
              {t('newForm.licenseIdLabel')}
            </label>
            <input
              id="license-id"
              value={licenseId}
              onChange={(event) => {
                setLicenseId(event.target.value);
                // 换了 ID，上一次的核对结果不再适用。
                setKnownLicense(null);
              }}
              placeholder={t('newForm.licenseIdPlaceholder')}
              aria-invalid={licenseError ? true : undefined}
              aria-describedby={licenseError ? 'license-id-error' : undefined}
              className="mt-1 w-full rounded border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            {licenseError && (
              <p id="license-id-error" className="mt-1 text-sm text-red-700 dark:text-red-300">
                {licenseError}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="revocation-reason" className="text-sm font-medium text-fg">
              {t('newForm.reasonLabel')}
            </label>
            <select
              id="revocation-reason"
              value={reason}
              onChange={(event) =>
                setReason(event.target.value as RevocationReason)
              }
              aria-invalid={reasonError ? true : undefined}
              aria-describedby={reasonError ? 'revocation-reason-error' : undefined}
              className="mt-1 w-full rounded border border-border bg-bg px-3 py-2 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              <option value="">{t('newForm.reasonPlaceholder')}</option>
              {REASONS.map((option) => (
                <option key={option} value={option}>
                  {t(`newForm.reasonOptions.${option}`)}
                </option>
              ))}
            </select>
            {reasonError && (
              <p id="revocation-reason-error" className="mt-1 text-sm text-red-700 dark:text-red-300">
                {reasonError}
              </p>
            )}
          </div>
        </div>

        <div>
          <label htmlFor="customer-ref" className="text-sm font-medium text-fg">
            {t('newForm.customerRefLabel')}
          </label>
          <input
            id="customer-ref"
            value={customerRef}
            onChange={(event) => setCustomerRef(event.target.value)}
            className="mt-1 w-full rounded border border-border bg-bg px-3 py-2 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>

        <div>
          <label htmlFor="revocation-notes" className="text-sm font-medium text-fg">
            {t('newForm.notesLabel')}
          </label>
          <textarea
            id="revocation-notes"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={3}
            className="mt-1 w-full rounded border border-border bg-bg px-3 py-2 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>

        <label className="inline-flex items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            checked={dryRun}
            onChange={(event) => setDryRun(event.target.checked)}
            className="h-4 w-4 rounded border-border"
          />
          {t('newForm.dryRun')}
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button
            ref={submitButtonRef}
            type="submit"
            disabled={submitState === 'loading' || checking}
            className="rounded bg-red-700 px-3 py-2 text-sm font-semibold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-red-600/40"
          >
            {checking
              ? t('newForm.checking')
              : submitState === 'loading'
                ? t('newForm.submitting')
                : t('newForm.submit')}
          </button>
          <p aria-live="polite" className="min-h-5 text-sm text-fg-muted">
            {message}
          </p>
        </div>
        {/* 演练 / 撤销完成后仍保留「未知许可证」提示，避免只在一闪而过的文案里出现。 */}
        {submitState === 'success' && knownLicense === false && (
          <UnknownLicenseWarning text={t('newForm.unknownLicenseWarning')} />
        )}
      </form>

      {pendingPayload && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="revoke-confirm-title"
          // codex 审查 Major-1：focus trap — Tab 在 Cancel ↔ Confirm 间循环
          onKeyDown={(event) => {
            if (event.key !== 'Tab') return;
            const cancel = cancelButtonRef.current;
            const focused = document.activeElement;
            if (event.shiftKey && focused === cancel) {
              // 反向 Tab 从 Cancel 跳回 Confirm（last focusable in modal）
              event.preventDefault();
              const confirmBtn = (event.currentTarget.querySelector(
                'button[type="button"][data-revoke-confirm]',
              ) as HTMLButtonElement | null);
              confirmBtn?.focus();
            }
          }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-md rounded-lg border border-border bg-bg p-5 shadow-xl">
            <h3 id="revoke-confirm-title" className="text-base font-semibold text-fg">
              {t('newForm.confirmTitle')}
            </h3>
            <p className="mt-2 text-sm text-fg-muted">
              {t('newForm.confirm', {
                licenseId: pendingPayload.licenseId,
                reason: t(`newForm.reasonOptions.${pendingPayload.reason}`),
              })}
            </p>
            {knownLicense === false && (
              <UnknownLicenseWarning text={t('newForm.unknownLicenseWarning')} />
            )}
            {pendingPayload.dryRun && (
              <p className="mt-2 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:border-blue-900/40 dark:bg-blue-900/20 dark:text-blue-200">
                {t('newForm.dryRunNotice')}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-3">
              <button
                ref={cancelButtonRef}
                type="button"
                onClick={() => setPendingPayload(null)}
                className="rounded border border-border px-3 py-2 text-sm font-medium text-fg hover:bg-bg-subtle focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                {t('newForm.cancel')}
              </button>
              <button
                type="button"
                data-revoke-confirm
                onClick={confirmSubmit}
                disabled={submitState === 'loading'}
                className="rounded bg-red-700 px-3 py-2 text-sm font-semibold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-red-600/40"
              >
                {t('newForm.confirmCta')}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** ID 不在已签发记录中的醒目提示（不阻止撤销：离线签发的许可证本就不在记录里）。 */
function UnknownLicenseWarning({ text }: { text: string }) {
  return (
    <p
      role="alert"
      className="mt-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900 dark:border-amber-700/60 dark:bg-amber-900/20 dark:text-amber-200"
    >
      {text}
    </p>
  );
}
