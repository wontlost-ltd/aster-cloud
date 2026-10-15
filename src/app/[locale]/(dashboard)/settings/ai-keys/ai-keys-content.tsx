'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  Breadcrumbs,
  ConfirmDialog,
  Container,
  Input,
  Label,
  PageHeader,
  Select,
} from '@/components/ui';
import { extractErrorMessage } from '@/lib/api/error-envelope';

interface BYOKBinding {
  id: string;
  provider: string;
  keyHint: string;
  active: boolean;
  providerUrl: string | null;
  tokenQuota: number | null;
  expiresAt: string | null;
  /** 同 provider 多 key 的调用优先级（数值小=优先级高）。 */
  priority: number;
  usedTokensThisMonth: number;
  lastUsedAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  createdAt: string;
  /** ADR 0048：用户指定的模型；null = 使用平台默认。 */
  model: string | null;
  availableModels: { models: string[] | null; defaultModel: string } | null;
  modelsCheckedAt: string | null;
}

const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  vertex: 'Google Vertex AI',
};

interface AiKeysContentProps {
  initialBindings: BYOKBinding[];
  locale: string;
}

/**
 * Bring-Your-Own-Key settings — fully i18n'd in EN / ZH / DE.
 *
 * The previous implementation had the entire UI (labels, errors,
 * confirm dialog, "Why use BYOK?" explainer) hard-coded in Chinese,
 * which made the page unreadable for English / German users even
 * when they switched locale. Strings now flow through next-intl
 * (settings.aiKeysPage.*) and provider names stay as proper nouns.
 */
export function AiKeysContent({ initialBindings, locale }: AiKeysContentProps) {
  const t = useTranslations('settings.aiKeysPage');
  const tSettings = useTranslations('settings');
  const [bindings, setBindings] = useState<BYOKBinding[]>(initialBindings);
  const [provider, setProvider] = useState<'openai' | 'anthropic' | 'vertex'>(
    'openai',
  );
  const [apiKey, setApiKey] = useState('');
  // BYOK 增强：可选 providerUrl / token 额度 / 失效日期。空字符串 = 不设置。
  const [providerUrl, setProviderUrl] = useState('');
  const [tokenQuota, setTokenQuota] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  // ADR 0048：可选模型 id；空 = 平台默认。notice = 保存成功但模型列表未能校验的提示。
  const [model, setModel] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Hydration-safe：toLocaleDateString/toLocaleString 在 SSR(Node) 与 CSR(浏览器) 的
  // 时区/locale 数据不同 → 首帧文本不一致 → React #418 hydration mismatch。用 mounted gate：
  // 服务端 + 客户端首帧都渲染确定性内容（ISO 日期 / 原始数字），挂载后再切 locale 格式。
  const [mounted, setMounted] = useState(false);
  // hydration-safe mounted gate：挂载后才切 locale 日期/数字格式，仅 set 一次，故意在 effect 内 set
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);
  const [success, setSuccess] = useState<string | null>(null);
  // 多 key：撤销按 binding **id**（同 provider 多 key）；对话框标签仍显示 provider 名。
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; provider: string } | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);
  // 重排优先级进行中的 provider（禁用该 provider 组的上移/下移按钮，防连点竞态）。
  const [reordering, setReordering] = useState<string | null>(null);
  // 行内编辑（改额度上限 / 失效日期，不重输 key）：editingId=当前编辑的 binding，null=无。
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editQuota, setEditQuota] = useState('');
  const [editExpiry, setEditExpiry] = useState('');
  const [editModel, setEditModel] = useState('');
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [resetConfirmId, setResetConfirmId] = useState<string | null>(null);
  // 已绑定 key 区（编辑/重置/撤销）的反馈与上面「新增 key」表单的 error/success 分开——否则
  // 在下方表格里改一个 key，成功提示却渲染到上面 form 底部，离操作点很远（用户反馈的位置错位）。
  const [rowError, setRowError] = useState<string | null>(null);
  const [rowSuccess, setRowSuccess] = useState<string | null>(null);

  const refresh = async () => {
    const r = await fetch('/api/user/ai-keys');
    if (r.ok) {
      const data = await r.json();
      setBindings(data.bindings ?? []);
    }
  };

  const startEdit = (b: BYOKBinding) => {
    setRowError(null);
    setRowSuccess(null);
    setEditingId(b.id);
    setEditQuota(b.tokenQuota != null ? String(b.tokenQuota) : '');
    // date input 要 YYYY-MM-DD；从 ISO 截前 10 位。
    setEditExpiry(b.expiresAt ? b.expiresAt.slice(0, 10) : '');
    setEditModel(b.model ?? '');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditQuota('');
    setEditExpiry('');
    setEditModel('');
  };

  const saveEdit = async (b: BYOKBinding) => {
    setRowError(null);
    setRowSuccess(null);
    // tokenQuota：空=清空（改无限，传 null）；否则须正整数。
    let quota: number | null = null;
    if (editQuota.trim() !== '') {
      const n = Number(editQuota);
      if (!Number.isInteger(n) || n <= 0) {
        setRowError(t('quotaInvalid'));
        return;
      }
      quota = n;
    }
    // expiresAt 仅在用户**真的改了**失效日期时才提交（省略 = 服务端不动该列）。
    // 关键边界（Codex 审查）：若 key 已过期、用户只想改额度，重发那个过期日期会被服务端
    // 「必须未来时间」拒绝。故比较当前输入与原值（都归一到 YYYY-MM-DD），未改则不带 expiresAt。
    const originalExpiryDay = b.expiresAt ? b.expiresAt.slice(0, 10) : '';
    const expiryChanged = editExpiry !== originalExpiryDay;
    // model 同理：仅在改动时提交，避免额度/过期编辑触发服务端模型重校验。
    const modelChanged = editModel.trim() !== (b.model ?? '');
    const payload: {
      id: string;
      action: 'update';
      tokenQuota: number | null;
      model?: string | null;
      expiresAt?: string | null;
    } = { id: b.id, action: 'update', tokenQuota: quota };
    if (modelChanged) payload.model = editModel.trim() || null;
    if (expiryChanged) {
      // 空=永不过期（null）；否则存当天 00:00:00 UTC（选哪天=那天起失效，见 handleSubmit 注释）。
      payload.expiresAt = editExpiry ? new Date(editExpiry + 'T00:00:00Z').toISOString() : null;
    }

    setRowBusy(b.id);
    try {
      const r = await fetch('/api/user/ai-keys', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        if (data.error === 'model_not_available') {
          setRowError(t('modelNotAvailable', { available: ((data.available as string[]) ?? []).join(', ') }));
          return;
        }
        setRowError(extractErrorMessage(data) || t('saveFailed', { status: r.status }));
        return;
      }
      setRowSuccess(t('editSaved'));
      cancelEdit();
      await refresh();
    } finally {
      setRowBusy(null);
    }
  };

  const confirmResetQuota = async () => {
    if (!resetConfirmId) return;
    setRowError(null);
    setRowSuccess(null);
    setRowBusy(resetConfirmId);
    try {
      const r = await fetch('/api/user/ai-keys', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resetQuota' }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        setRowError(extractErrorMessage(data) || t('resetFailed', { status: r.status }));
        return;
      }
      setRowSuccess(t('quotaReset'));
      await refresh();
    } finally {
      setRowBusy(null);
      setResetConfirmId(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setNotice(null);
    if (apiKey.length < 20) {
      setError(t('keyTooShort'));
      return;
    }
    if (model.trim() && !/^[A-Za-z0-9._:/-]{1,128}$/.test(model.trim())) {
      setError(t('modelInvalid'));
      return;
    }
    // 本地校验 tokenQuota（正整数）——服务端也校验,这里给即时反馈。
    let quotaNum: number | null = null;
    if (tokenQuota.trim() !== '') {
      const n = Number(tokenQuota);
      if (!Number.isInteger(n) || n <= 0) {
        setError(t('quotaInvalid'));
        return;
      }
      quotaNum = n;
    }
    setSubmitting(true);
    try {
      const r = await fetch('/api/user/ai-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          apiKey,
          model: model.trim() || null,
          providerUrl: providerUrl.trim() || null,
          tokenQuota: quotaNum,
          // 失效语义：选「7-31」= 7-31 当天起就不能用（该日已失效）。故存**当天 00:00:00 UTC**——
          // 推理层 expiresAt<=now 即拒，key 在 7-31 当天内失效（而非存 23:59:59 让它当天整天仍可用）。
          // 注：系统不追踪用户时区，用 UTC 日界；UTC+8 用户该日 08:00 起失效（仍落在 7-31 当天，符合语义）。
          expiresAt: expiresAt ? new Date(expiresAt + 'T00:00:00Z').toISOString() : null,
        }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        if (data.error === 'model_not_available') {
          setError(t('modelNotAvailable', { available: ((data.available as string[]) ?? []).join(', ') }));
          return;
        }
        setError(extractErrorMessage(data) || t('saveFailed', { status: r.status }));
        return;
      }
      const okData = await r.json().catch(() => ({}));
      if (okData.modelsChecked === false) setNotice(t('modelUnverified'));
      setModel('');
      setApiKey('');
      setProviderUrl('');
      setTokenQuota('');
      setExpiresAt('');
      setSuccess(
        t('saved', { provider: PROVIDER_LABELS[provider] ?? provider }),
      );
      await refresh();
    } finally {
      setSubmitting(false);
    }
  };

  const handleRevoke = (b: BYOKBinding) =>
    setRevokeTarget({ id: b.id, provider: b.provider });

  const confirmRevoke = async () => {
    if (!revokeTarget) return;
    setIsRevoking(true);
    setRowError(null);
    setRowSuccess(null);
    try {
      const r = await fetch(
        `/api/user/ai-keys?id=${encodeURIComponent(revokeTarget.id)}`,
        { method: 'DELETE' },
      );
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        setRowError(extractErrorMessage(data) || t('revokeFailed', { status: r.status }));
        return;
      }
      await refresh();
    } finally {
      setIsRevoking(false);
      setRevokeTarget(null);
    }
  };

  // 多 key 优先级重排：把某 provider 组内某 key 上移/下移一位，提交新顺序（全组 id 数组）。
  // 乐观：先本地重排 bindings 立即反馈，再 PATCH；失败则 refresh 拿服务端权威值回滚。
  const moveKey = async (b: BYOKBinding, dir: -1 | 1) => {
    setRowError(null);
    setRowSuccess(null);
    // 该 provider 组按当前展示顺序（已是 priority asc）取出。
    const group = bindings.filter((x) => x.provider === b.provider);
    const idx = group.findIndex((x) => x.id === b.id);
    const swapWith = idx + dir;
    if (idx < 0 || swapWith < 0 || swapWith >= group.length) return; // 越界（首/末）静默忽略
    const reordered = [...group];
    [reordered[idx], reordered[swapWith]] = [reordered[swapWith], reordered[idx]];
    const orderedIds = reordered.map((x) => x.id);

    // 乐观更新：把该组替换为新顺序，其它 provider 组不动。
    const others = bindings.filter((x) => x.provider !== b.provider);
    setBindings([...others, ...reordered].sort((a, c) =>
      a.provider === c.provider ? 0 : a.provider < c.provider ? -1 : 1,
    ));

    setReordering(b.provider);
    try {
      const r = await fetch('/api/user/ai-keys', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reorder', provider: b.provider, orderedIds }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        setRowError(extractErrorMessage(data) || t('reorderFailed', { status: r.status }));
      }
      // 无论成败都 refresh：成功=对齐服务端 priority，失败=回滚乐观更新。
      await refresh();
    } finally {
      setReordering(null);
    }
  };

  // 失效日期是**日历日**（用户选一天，非某个时刻），存为该日 00:00:00 UTC。显示必须按 **UTC**
  // 日期部分渲染，否则 UTC+8 浏览器把 00:00Z 本地化会把日期往后错一天（用户选 7-31 却显示 8-1）。
  // 挂载前后都用 iso 前 10 位（YYYY-MM-DD）——即存进去的日历日，SSR/CSR 一致、零时区漂移。
  const formatExpiry = (iso: string | null) => {
    if (!iso) return t('noExpiry');
    if (!mounted) return iso.slice(0, 10);
    // 用 UTC 部分构造只含日期的本地格式（不引入本地时区偏移）。
    const d = new Date(iso);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toLocaleDateString(
      locale,
      { timeZone: 'UTC' },
    );
  };

  // 创建/最近使用是**真实时刻**（instant），按浏览器本地时区显示日期**+时分**才不含糊
  // （半夜发生的事件在本地显示成「当地那天+时刻」是正确的，与 formatExpiry 的日历日语义不同）。
  const formatDateTime = (iso: string | null) => {
    if (!iso) return t('never');
    if (!mounted) return iso.slice(0, 16).replace('T', ' '); // SSR/CSR 一致的确定性 UTC 占位
    return new Date(iso).toLocaleString(locale, {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };
  // 数字千分位同理 hydration-safe：挂载前用原始数字串，挂载后用 locale 格式。
  const formatNum = (n: number) => (mounted ? n.toLocaleString(locale) : String(n));

  // 多 key：某 key 在其 provider 组内的位置（bindings 已按 provider→priority 排序）——用于
  // 决定「上移/下移」是否可用（组内首个不能上移，末个不能下移）与显示 1/N 序号。
  const groupPos = (b: BYOKBinding) => {
    const group = bindings.filter((x) => x.provider === b.provider);
    return { index: group.findIndex((x) => x.id === b.id), size: group.length };
  };

  return (
    <Container size="xl" className="py-6 sm:py-10">
      {/* deep 页：保留 Breadcrumbs（settings → AI keys），放进 PageHeader 的 breadcrumbs 槽。 */}
      <PageHeader
        title={t('title')}
        subtitle={
          <>
            {t('subtitle')}{' '}
            <Link
              href={`/${locale}/dashboard`}
              className="ml-2 text-primary hover:underline"
            >
              {t('viewUsage')}
            </Link>
          </>
        }
        breadcrumbs={
          <Breadcrumbs
            items={[
              { label: tSettings('title'), href: '/settings' },
              { label: t('breadcrumb') },
            ]}
          />
        }
        className="mb-6"
      />

      <section className="mt-6 rounded-lg border border-border bg-bg p-6">
        <h2 className="text-lg font-semibold text-fg">{t('addTitle')}</h2>
        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          {/* Use the @aster-cloud/ui primitives so the form inputs match
              the design-system standard (token-driven border, focus ring,
              size variants) — replaces the previous hand-rolled
              `<input>` / `<select>` markup that diverged from
              Storybook's component contracts. */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="ai-keys-provider">{t('provider')}</Label>
            <Select
              id="ai-keys-provider"
              value={provider}
              onChange={(e) =>
                setProvider(
                  e.target.value as 'openai' | 'anthropic' | 'vertex',
                )
              }
            >
              <option value="openai">{t('providerOpenai')}</option>
              <option value="anthropic">{t('providerAnthropic')}</option>
              <option value="vertex">{t('providerVertex')}</option>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="ai-keys-model">{t('model')}</Label>
            <Input
              id="ai-keys-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={t('modelPlaceholder')}
            />
            <p className="text-xs text-fg-muted">{t('modelHint')}</p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="ai-keys-secret">{t('apiKey')}</Label>
            <Input
              id="ai-keys-secret"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
              placeholder="sk-..."
              required
            />
            <p className="text-xs text-fg-muted">{t('apiKeyHint')}</p>
          </div>

          {/* BYOK 可选高级设置：自定义 Provider URL / token 额度 / 失效日期 */}
          <div className="flex flex-col gap-4 rounded-md border border-border p-4">
            <p className="text-sm font-medium text-fg-muted">{t('advancedTitle')}</p>

            <div className="flex flex-col gap-2">
              <Label htmlFor="ai-keys-url">{t('providerUrl')}</Label>
              <Input
                id="ai-keys-url"
                type="url"
                value={providerUrl}
                onChange={(e) => setProviderUrl(e.target.value)}
                autoComplete="off"
                placeholder="https://api.openai.com/v1"
              />
              <p className="text-xs text-fg-muted">{t('providerUrlHint')}</p>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="ai-keys-quota">{t('tokenQuota')}</Label>
              <Input
                id="ai-keys-quota"
                type="number"
                min="1"
                step="1"
                value={tokenQuota}
                onChange={(e) => setTokenQuota(e.target.value)}
                placeholder={t('tokenQuotaPlaceholder')}
              />
              <p className="text-xs text-fg-muted">{t('tokenQuotaHint')}</p>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="ai-keys-expiry">{t('expiresAt')}</Label>
              <Input
                id="ai-keys-expiry"
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
              <p className="text-xs text-fg-muted">{t('expiresAtHint')}</p>
            </div>
          </div>

          {error && (
            <div className="rounded-md bg-red-50 p-3 text-sm text-red-800">
              {error}
            </div>
          )}
          {success && (
            <div className="rounded-md bg-green-50 p-3 text-sm text-green-800">
              {success}
            </div>
          )}
          {notice && (
            <p className="text-sm text-amber-700" role="status">
              {notice}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
          >
            {submitting ? t('saving') : t('save')}
          </button>
        </form>
      </section>

      <section className="mt-6 rounded-lg border border-border bg-bg p-6">
        <h2 className="text-lg font-semibold text-fg">{t('boundTitle')}</h2>

        {/* 已绑定 key 区的反馈就近渲染（编辑/重置/撤销的结果）——与上面「新增 key」表单的
            error/success 分开，避免在下方表格操作却把提示显示到上面 form 底部。 */}
        {rowError && (
          <div role="alert" className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800">
            {rowError}
          </div>
        )}
        {rowSuccess && (
          <div role="status" className="mt-3 rounded-md bg-green-50 p-3 text-sm text-green-800">
            {rowSuccess}
          </div>
        )}

        {bindings.length === 0 ? (
          <p className="mt-3 text-sm text-fg-muted">{t('noneBound')}</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase text-fg-muted">
                  <th className="pb-2 text-left">{t('thProvider')}</th>
                  <th className="pb-2 text-left">{t('thPriority')}</th>
                  <th className="pb-2 text-left">{t('thKeyHint')}</th>
                  <th className="pb-2 text-left">{t('thModel')}</th>
                  <th className="pb-2 text-left">{t('thStatus')}</th>
                  <th className="pb-2 text-left">{t('thQuota')}</th>
                  <th className="pb-2 text-left">{t('thExpiry')}</th>
                  <th className="pb-2 text-left">{t('thLastUsed')}</th>
                  <th className="pb-2 text-left">{t('thCreated')}</th>
                  <th className="pb-2 text-left">{t('thActions')}</th>
                </tr>
              </thead>
              <tbody>
                {bindings.map((b) => (
                  <tr key={b.id} className="border-b border-border">
                    <td className="py-3">
                      {PROVIDER_LABELS[b.provider] ?? b.provider}
                    </td>
                    <td className="py-3">
                      {(() => {
                        const { index, size } = groupPos(b);
                        // 组内只有 1 个 key 时不显示排序控件（无可排）。
                        if (size <= 1) return <span className="text-fg-muted">—</span>;
                        const busyReorder = reordering === b.provider;
                        return (
                          <div className="flex items-center gap-1">
                            <span className="tabular-nums text-xs text-fg-muted">
                              {index + 1}/{size}
                            </span>
                            <button
                              type="button"
                              onClick={() => moveKey(b, -1)}
                              disabled={index === 0 || busyReorder}
                              aria-label={t('moveUp')}
                              title={t('moveUp')}
                              className="rounded px-1 text-fg-muted hover:text-fg disabled:opacity-30"
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              onClick={() => moveKey(b, 1)}
                              disabled={index === size - 1 || busyReorder}
                              aria-label={t('moveDown')}
                              title={t('moveDown')}
                              className="rounded px-1 text-fg-muted hover:text-fg disabled:opacity-30"
                            >
                              ↓
                            </button>
                          </div>
                        );
                      })()}
                    </td>
                    <td className="py-3 font-mono text-xs">****{b.keyHint}</td>
                    <td className="py-3 font-mono text-xs">
                      {editingId === b.id ? (
                        <Input
                          value={editModel}
                          onChange={(e) => setEditModel(e.target.value)}
                          placeholder={t('modelPlaceholder')}
                          aria-label={t('model')}
                        />
                      ) : b.model ? (
                        b.model
                      ) : (
                        <span className="font-sans text-fg-muted">
                          {b.availableModels?.defaultModel
                            ? t('modelDefault', { model: b.availableModels.defaultModel })
                            : t('modelDefaultUnknown')}
                        </span>
                      )}
                    </td>
                    <td className="py-3">
                      {b.active ? (
                        <span className="rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
                          {t('statusActive')}
                        </span>
                      ) : (
                        <span className="rounded bg-bg-muted px-2 py-0.5 text-xs font-medium text-fg-muted">
                          {t('statusDisabled')}
                        </span>
                      )}
                      {b.lastError && (
                        <span
                          className="ml-2 cursor-help rounded bg-red-100 px-2 py-0.5 text-xs text-red-700"
                          title={b.lastError}
                        >
                          {t('lastError')}
                        </span>
                      )}
                    </td>
                    <td className="py-3 text-fg-muted">
                      {editingId === b.id ? (
                        <Input
                          type="number"
                          min="1"
                          step="1"
                          value={editQuota}
                          onChange={(e) => setEditQuota(e.target.value)}
                          placeholder={t('quotaUnlimited')}
                          className="w-28"
                          aria-label={t('tokenQuota')}
                        />
                      ) : b.tokenQuota == null ? (
                        t('quotaUnlimited')
                      ) : (
                        t('quotaUsage', {
                          used: formatNum(b.usedTokensThisMonth),
                          quota: formatNum(b.tokenQuota),
                        })
                      )}
                    </td>
                    <td className="py-3 text-fg-muted">
                      {editingId === b.id ? (
                        <Input
                          type="date"
                          value={editExpiry}
                          onChange={(e) => setEditExpiry(e.target.value)}
                          className="w-40"
                          aria-label={t('expiresAt')}
                        />
                      ) : (
                        formatExpiry(b.expiresAt)
                      )}
                    </td>
                    <td className="py-3 text-fg-muted">
                      {formatDateTime(b.lastUsedAt)}
                    </td>
                    <td className="py-3 text-fg-muted">
                      {formatDateTime(b.createdAt)}
                    </td>
                    <td className="py-3">
                      {editingId === b.id ? (
                        <div className="flex gap-3">
                          <button
                            onClick={() => saveEdit(b)}
                            disabled={rowBusy === b.id}
                            className="text-xs text-primary hover:underline disabled:opacity-50"
                          >
                            {rowBusy === b.id ? t('saving') : t('editSave')}
                          </button>
                          <button
                            onClick={cancelEdit}
                            disabled={rowBusy === b.id}
                            className="text-xs text-fg-muted hover:underline disabled:opacity-50"
                          >
                            {t('editCancel')}
                          </button>
                        </div>
                      ) : (
                        <div className="flex gap-3">
                          <button
                            onClick={() => startEdit(b)}
                            className="text-xs text-primary hover:underline"
                          >
                            {t('edit')}
                          </button>
                          <button
                            onClick={() => setResetConfirmId(b.id)}
                            className="text-xs text-primary hover:underline"
                          >
                            {t('resetQuota')}
                          </button>
                          <button
                            onClick={() => handleRevoke(b)}
                            className="text-xs text-red-600 hover:underline"
                          >
                            {t('delete')}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-6 rounded-lg border border-border bg-bg-subtle p-6">
        <h3 className="text-base font-semibold text-fg">{t('whyTitle')}</h3>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-fg">
          <li>{t('whyQuota')}</li>
          <li>{t('whyBilling')}</li>
          <li>{t('whyCompliance')}</li>
        </ul>
      </section>

      <ConfirmDialog
        isOpen={revokeTarget !== null}
        title={t('revokeDialogTitle')}
        description={
          revokeTarget
            ? t('revokeDialogBody', {
                provider: PROVIDER_LABELS[revokeTarget.provider] ?? revokeTarget.provider,
              })
            : ''
        }
        confirmLabel={t('revokeDialogConfirm')}
        cancelLabel={t('revokeDialogCancel')}
        variant="danger"
        isLoading={isRevoking}
        onConfirm={confirmRevoke}
        onCancel={() => !isRevoking && setRevokeTarget(null)}
      />

      <ConfirmDialog
        isOpen={resetConfirmId !== null}
        title={t('resetDialogTitle')}
        description={t('resetDialogBody')}
        confirmLabel={t('resetDialogConfirm')}
        cancelLabel={t('resetDialogCancel')}
        isLoading={rowBusy !== null && rowBusy === resetConfirmId}
        onConfirm={confirmResetQuota}
        onCancel={() => rowBusy === null && setResetConfirmId(null)}
      />
    </Container>
  );
}
