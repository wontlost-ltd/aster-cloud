'use client';

/**
 * 签名事实签发方面板（ADR 0040 §11 D3；ADR 0046 §11.7 裁定 4、14）：团队设置页与个人设置子页共用。
 *
 * 自取 `GET /api/fact-issuers/[tenantId]`（aster-api 是唯一真相源，cloud 不存签发方状态），按 `canManage`
 * 决定是否渲染写操作：
 * - 「启用 Aster Cloud 签发方」：平台密钥可用且本租户尚未登记同一 issuer#kid 时出现，只登记平台公钥；
 *   已吊销的同键不能再启用（api 409 issuer_revoked），故同键存在即隐藏；
 * - 「登记外部签发方」：issuer、kid、publicKey、可选到期日（按 UTC 当日结束）；
 * - 「吊销」：二次确认，不可恢复，依赖该签发方的待审批由 aster-api 自动拒绝。
 * 错误按 code 本地化，不显示 api 原文。
 */

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Alert, Badge, Button, Card, CardBody, ConfirmDialog, Input, Label, Stack } from '@/components/ui';
import { formatDate } from '@/lib/format';
import type { GuardFactIssuer } from '@/services/policy/guard-types';

interface CloudIssuer {
  issuer: string;
  kid: string;
  publicKey: string;
}

interface IssuersState {
  issuers: GuardFactIssuer[];
  cloudIssuer: CloudIssuer | null;
  canManage: boolean;
}

/** 有本地化文案的错误码；其余显示通用文案。 */
const KNOWN_ERRORS = new Set([
  'invalid_issuer_name',
  'invalid_issuer',
  'issuer_key_conflict',
  'issuer_revoked',
  'issuer_not_found',
  'receipt_unavailable',
  'upstream_unavailable',
  'forbidden',
]);

const refOf = (row: { issuer: string; kid: string }) => `${row.issuer}#${row.kid}`;

function issuerUrl(tenantId: string, issuer: string, kid: string): string {
  return `/api/fact-issuers/${encodeURIComponent(tenantId)}/${encodeURIComponent(issuer)}/${encodeURIComponent(kid)}`;
}

/** 失败响应的错误码；无法解析时为 null。 */
async function errorCode(res: Response): Promise<string | null> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === 'string' ? body.error : null;
}

const EMPTY_FORM = { issuer: '', kid: '', publicKey: '', notAfter: '' };

export function FactIssuersPanel({ tenantId }: { tenantId: string }) {
  const t = useTranslations('factIssuers');
  const locale = useLocale();
  const [state, setState] = useState<IssuersState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [revoking, setRevoking] = useState<GuardFactIssuer | null>(null);

  const errorText = useCallback(
    (code: string | null) => t(code && KNOWN_ERRORS.has(code) ? `errors.${code}` : 'errors.generic'),
    [t],
  );

  /** 纯取数，不碰 state，便于在 effect 中安全调用。 */
  const fetchIssuers = useCallback(async (): Promise<IssuersState | null> => {
    try {
      const res = await fetch(`/api/fact-issuers/${encodeURIComponent(tenantId)}`, { cache: 'no-store' });
      return res.ok ? ((await res.json()) as IssuersState) : null;
    } catch {
      return null;
    }
  }, [tenantId]);

  const reload = useCallback(async () => {
    const next = await fetchIssuers();
    setLoadFailed(!next);
    if (next) setState(next);
  }, [fetchIssuers]);

  useEffect(() => {
    let cancelled = false;
    fetchIssuers().then((next) => {
      if (cancelled) return;
      setLoadFailed(!next);
      if (next) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchIssuers]);

  /** 发出一次写请求；成功后重新拉取列表，失败显示本地化错误。返回是否成功。 */
  const mutate = async (url: string, init: RequestInit): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        setError(errorText(await errorCode(res)));
        // 吊销联动未完成（503）时签发方已禁用：刷新列表反映真实状态
        if (res.status === 503) await reload();
        return false;
      }
      await reload();
      return true;
    } catch {
      setError(errorText(null));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const put = (issuer: string, kid: string, body: Record<string, unknown>) =>
    mutate(issuerUrl(tenantId, issuer, kid), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const enableCloud = (cloud: CloudIssuer) => put(cloud.issuer, cloud.kid, { publicKey: cloud.publicKey });

  const register = async (e: React.FormEvent) => {
    e.preventDefault();
    const notAfter = form.notAfter ? `${form.notAfter}T23:59:59Z` : undefined;
    const ok = await put(form.issuer.trim(), form.kid.trim(), {
      publicKey: form.publicKey.trim(),
      ...(notAfter ? { notAfter } : {}),
    });
    if (ok) setForm(EMPTY_FORM);
  };

  const confirmRevoke = async () => {
    if (!revoking) return;
    const target = revoking;
    setRevoking(null);
    await mutate(issuerUrl(tenantId, target.issuer, target.kid), { method: 'DELETE' });
  };

  const cloud = state?.cloudIssuer ?? null;
  const cloudRegistered = !!cloud && !!state?.issuers.some((row) => refOf(row) === refOf(cloud));

  return (
    <Card>
      <CardBody className="pt-6">
        <Stack gap={4}>
          <Stack gap={1}>
            <h2 className="font-display text-xl font-semibold tracking-tight text-fg">{t('title')}</h2>
            <p className="text-sm text-fg-muted">{t('description')}</p>
          </Stack>

          {loadFailed && <Alert variant="danger">{t('loadFailed')}</Alert>}
          {error && <Alert variant="danger">{error}</Alert>}

          {!state && !loadFailed && <div className="h-6 w-32 animate-pulse rounded bg-bg-muted" />}

          {state && (
            <>
              {!state.canManage && <p className="text-sm text-fg-muted">{t('readOnlyHint')}</p>}

              <CloudIssuerRow
                cloud={cloud}
                registered={cloudRegistered}
                canManage={state.canManage}
                busy={busy}
                onEnable={enableCloud}
              />

              <IssuerTable
                issuers={state.issuers}
                cloud={cloud}
                canManage={state.canManage}
                busy={busy}
                locale={locale}
                onRevoke={setRevoking}
              />

              {state.canManage && (
                <RegisterForm form={form} busy={busy} onChange={setForm} onSubmit={register} />
              )}
            </>
          )}
        </Stack>
      </CardBody>

      <ConfirmDialog
        isOpen={!!revoking}
        title={t('revokeConfirmTitle')}
        description={revoking ? t('revokeConfirmBody', { issuer: refOf(revoking) }) : ''}
        confirmLabel={t('revokeConfirm')}
        cancelLabel={t('cancel')}
        variant="danger"
        isLoading={busy}
        onConfirm={confirmRevoke}
        onCancel={() => setRevoking(null)}
      />
    </Card>
  );
}

function CloudIssuerRow({
  cloud, registered, canManage, busy, onEnable,
}: {
  cloud: CloudIssuer | null;
  registered: boolean;
  canManage: boolean;
  busy: boolean;
  onEnable: (cloud: CloudIssuer) => void;
}) {
  const t = useTranslations('factIssuers');
  if (!cloud) return <p className="text-sm text-fg-muted">{t('cloudUnavailable')}</p>;
  if (registered) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-bg-subtle p-3">
      <Stack gap={1} className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg">{t('cloudTitle')}</p>
        <p className="text-xs text-fg-muted">{t('cloudDescription', { issuer: refOf(cloud) })}</p>
      </Stack>
      {canManage && (
        <Button size="sm" variant="primary" disabled={busy} onClick={() => onEnable(cloud)}>
          {t('enableCloud')}
        </Button>
      )}
    </div>
  );
}

function IssuerTable({
  issuers, cloud, canManage, busy, locale, onRevoke,
}: {
  issuers: GuardFactIssuer[];
  cloud: CloudIssuer | null;
  canManage: boolean;
  busy: boolean;
  locale: string;
  onRevoke: (row: GuardFactIssuer) => void;
}) {
  const t = useTranslations('factIssuers');
  if (issuers.length === 0) return <p className="text-sm text-fg-muted">{t('empty')}</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-border text-xs uppercase text-fg-muted">
            <th className="px-4 py-2 text-left">{t('thIssuer')}</th>
            <th className="px-4 py-2 text-left">{t('thKid')}</th>
            <th className="px-4 py-2 text-left">{t('thStatus')}</th>
            <th className="px-4 py-2 text-left">{t('thNotAfter')}</th>
            <th className="px-4 py-2 text-left">{t('thCreatedBy')}</th>
            {canManage && <th className="px-4 py-2 text-left">{t('thActions')}</th>}
          </tr>
        </thead>
        <tbody>
          {issuers.map((row) => (
            <tr key={refOf(row)} data-testid={`fact-issuer-${refOf(row)}`} className="border-b border-border">
              <td className="px-4 py-3 font-medium text-fg">
                <span className="break-all">{row.issuer}</span>
                {cloud && refOf(cloud) === refOf(row) && (
                  <Badge variant="neutral" className="ml-2">{t('cloudBadge')}</Badge>
                )}
              </td>
              <td className="px-4 py-3 font-mono text-xs">{row.kid}</td>
              <td className="px-4 py-3">
                <Badge variant={row.enabled ? 'success' : 'neutral'}>
                  {t(row.enabled ? 'statusEnabled' : 'statusRevoked')}
                </Badge>
              </td>
              <td className="px-4 py-3 text-fg-muted">{row.notAfter ? formatDate(row.notAfter, locale) : t('noExpiry')}</td>
              <td className="px-4 py-3 text-fg-muted">{row.createdBy}</td>
              {canManage && (
                <td className="px-4 py-3">
                  {row.enabled && (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => onRevoke(row)}>
                      {t('revoke')}
                    </Button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RegisterForm({
  form, busy, onChange, onSubmit,
}: {
  form: typeof EMPTY_FORM;
  busy: boolean;
  onChange: (next: typeof EMPTY_FORM) => void;
  onSubmit: (e: React.FormEvent) => void;
}) {
  const t = useTranslations('factIssuers');
  const field = (key: keyof typeof EMPTY_FORM) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...form, [key]: e.target.value });
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 rounded-md border border-border p-4">
      <Stack gap={1}>
        <h3 className="text-sm font-semibold text-fg">{t('registerTitle')}</h3>
        <p className="text-xs text-fg-muted">{t('registerHint')}</p>
      </Stack>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="fact-issuer-issuer">{t('issuerLabel')}</Label>
          <Input id="fact-issuer-issuer" required maxLength={255} value={form.issuer} onChange={field('issuer')} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="fact-issuer-kid">{t('kidLabel')}</Label>
          <Input id="fact-issuer-kid" required maxLength={64} value={form.kid} onChange={field('kid')} />
        </div>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <Label htmlFor="fact-issuer-public-key">{t('publicKeyLabel')}</Label>
          <Input id="fact-issuer-public-key" required className="font-mono" value={form.publicKey}
            onChange={field('publicKey')} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="fact-issuer-not-after">{t('notAfterLabel')}</Label>
          <Input id="fact-issuer-not-after" type="date" value={form.notAfter} onChange={field('notAfter')} />
        </div>
      </div>
      <div>
        <Button type="submit" variant="primary" disabled={busy}>{t('register')}</Button>
      </div>
    </form>
  );
}
