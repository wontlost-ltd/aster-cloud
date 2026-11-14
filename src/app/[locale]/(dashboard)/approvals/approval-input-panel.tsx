'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, Badge, Button } from '@/components/ui';
import type { GuardApprovalInput } from '@/services/policy/guard-types';

/**
 * 审批行展开后的「决策输入」面板（ADR 0042 §12 D10）。
 *
 * 只在展开时请求 `GET /api/approvals/[tenantId]/[approvalId]/input`（以当前用户身份转发，api 永远返回打码视图）。
 * 树形展示，结构保留：`$pii` 显示为级别 + 类别徽标，未声明类型显示「不可见」徽标；`context` 叶子旁显示来源徽标
 * （路径 ∈ `inputSources.verified` 为「已验证」，悬停显示对应的 factSources 条目，其余为「自报」）。
 * 「显示原值」只对 `canReveal` 且存在已声明 `@pii` 字段的可用视图出现，先确认再调用解除（按人记入审计链）。
 *
 * `onViewLoaded` 把当前展示的视图交给收件箱：批准 / 拒绝据此提交 `inputSnapshotHash`。
 * - 旧 api（代理把无输入端点的 404 转为 `status: unavailable`）与其他非临时错误：交 null，收件箱照常审批、不带哈希
 *   （ADR 0042 §12 D10「对 api 的 404 / 未知错误一律按输入不可用」）；
 * - 临时失败（网络错误、502 / 503 / 504）：不交视图，显示重试；此时审批服务同样不可用，不应放行无哈希审批；
 * - 重新拉取期间交 undefined，收件箱随之禁用批准 / 拒绝。
 */

type T = ReturnType<typeof useTranslations>;

interface Props {
  tenantId: string;
  approvalId: string;
  /** 持所需业务角色的可审者（`canAct && requiredRole != null`）；ESCALATE 无所需角色，不可解除。 */
  canReveal: boolean;
  onViewLoaded: (view: GuardApprovalInput | null | undefined) => void;
}

const TRANSIENT_STATUSES = new Set([502, 503, 504]);

type PiiValue = { $pii: { level: string; category?: string } };

function piiOf(value: unknown): PiiValue['$pii'] | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  const pii = (value as Record<string, unknown>).$pii;
  if (keys.length !== 1 || typeof pii !== 'object' || pii === null) return null;
  const level = (pii as Record<string, unknown>).level;
  const category = (pii as Record<string, unknown>).category;
  return typeof level === 'string' ? { level, ...(typeof category === 'string' ? { category } : {}) } : null;
}

function inputUrl(tenantId: string, approvalId: string, reveal = false): string {
  return `/api/approvals/${encodeURIComponent(tenantId)}/${encodeURIComponent(approvalId)}/input${reveal ? '/reveal' : ''}`;
}

function PiiBadge({ pii, t }: { pii: PiiValue['$pii']; t: T }) {
  if (pii.level === 'unknown') {
    return <Badge variant="neutral" data-testid="pii-unknown">{t('input.badge.unknown')}</Badge>;
  }
  return (
    <Badge variant="warning" data-testid="pii-masked">
      {pii.category ? t('input.badge.pii', { level: pii.level, category: pii.category }) : pii.level}
    </Badge>
  );
}

/** 只给 `context.*` 叶子标来源：principal / action 等结构键不经签名事实判定。 */
function SourceBadge({ path, view, t }: { path: string; view: GuardApprovalInput; t: T }) {
  if (!path.startsWith('context.')) return null;
  const verified = view.inputSources?.verified ?? [];
  if (!verified.includes(path)) {
    return <Badge variant="neutral" data-testid="source-declared">{t('input.source.declared')}</Badge>;
  }
  const sources = (view.inputSources?.factSources ?? []).filter((entry) => entry.startsWith(`${path}=`));
  return (
    <Badge variant="success" data-testid="source-verified" title={sources.join('\n') || undefined}>
      {t('input.source.verified')}
    </Badge>
  );
}

function Leaf({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-fg-muted">null</span>;
  if (Array.isArray(value)) return <span className="font-mono">{JSON.stringify(value)}</span>;
  return <span className="font-mono">{String(value)}</span>;
}

/** 递归渲染；path 用与 api 相同的语法（对象键 `.`，数组元素 `[]`）。 */
function Node({ name, value, path, view, t }: { name: string; value: unknown; path: string; view: GuardApprovalInput; t: T }) {
  const pii = piiOf(value);
  const isObject = typeof value === 'object' && value !== null && !Array.isArray(value) && !pii;
  const isRecordList = Array.isArray(value) && value.some((v) => typeof v === 'object' && v !== null);
  if (isObject || isRecordList) {
    const entries: Array<[string, unknown, string]> = isObject
      ? Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, v, `${path}.${k}`])
      : (value as unknown[]).map((v, i) => [`[${i}]`, v, `${path}[]`]);
    return (
      <li>
        <span className="font-medium text-fg">{name}</span>
        <ul className="ml-4 border-l border-border pl-3">
          {/* path 与 api 同一语法：数组元素不带下标（`items[]`），来源徽标按它匹配 inputSources.verified；key 带下标保证唯一 */}
          {entries.map(([k, v, p]) => (
            <Node key={k} name={k} value={v} path={p} view={view} t={t} />
          ))}
        </ul>
      </li>
    );
  }
  return (
    <li className="flex flex-wrap items-center gap-2" data-path={path}>
      <span className="text-fg-muted">{name}:</span>
      {pii ? <PiiBadge pii={pii} t={t} /> : <Leaf value={value} />}
      <SourceBadge path={path} view={view} t={t} />
    </li>
  );
}

/** 输入中是否有可解除的 `@pii` 占位（级别不是 unknown）；没有就不提供「显示原值」，免得留下无意义的审计记录。 */
function hasMaskedPii(value: unknown): boolean {
  const pii = piiOf(value);
  if (pii) return pii.level !== 'unknown';
  if (Array.isArray(value)) return value.some(hasMaskedPii);
  if (typeof value === 'object' && value !== null) return Object.values(value).some(hasMaskedPii);
  return false;
}

function revealErrorText(t: T, code: string | undefined): string {
  switch (code) {
    case 'reveal_not_permitted':
    case 'input_not_available':
    case 'receipt_unavailable':
    case 'approval_not_pending':
      return t(`input.errors.${code}`);
    default:
      return t('input.errors.generic');
  }
}

function Banners({ view, t }: { view: GuardApprovalInput; t: T }) {
  if (view.status !== 'available') {
    return <Alert variant="warning" data-testid="input-status">{t(`input.status.${view.status}`)}</Alert>;
  }
  return (
    <>
      {view.inputBinding === 'unbound' && <Alert variant="warning" data-testid="banner-unbound">{t('input.banner.unbound')}</Alert>}
      {view.marksSource === 'none' && <Alert variant="warning" data-testid="banner-marks-none">{t('input.banner.marksNone')}</Alert>}
      {view.factsStale && <Alert variant="warning" data-testid="banner-facts-stale">{t('input.banner.factsStale')}</Alert>}
      {view.revealed && <Alert variant="info" data-testid="banner-revealed">{t('input.revealedNote')}</Alert>}
    </>
  );
}

export function ApprovalInputPanel({ tenantId, approvalId, canReveal, onViewLoaded }: Props) {
  const t = useTranslations('approvals');
  const [view, setView] = useState<GuardApprovalInput | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 作废当前视图并重新拉取；期间交 undefined，收件箱随之禁用批准 / 拒绝。 */
  const reload = () => {
    setView(undefined);
    setFailed(false);
    setConfirming(false);
    onViewLoaded(undefined);
    setAttempt((n) => n + 1);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let loaded: GuardApprovalInput | null;
      try {
        const r = await fetch(inputUrl(tenantId, approvalId));
        if (TRANSIENT_STATUSES.has(r.status)) {
          if (!cancelled) setFailed(true);
          return;
        }
        loaded = r.ok ? ((await r.json()) as GuardApprovalInput) : null;
      } catch {
        if (!cancelled) setFailed(true);
        return;
      }
      if (cancelled) return;
      setView(loaded);
      onViewLoaded(loaded);
    })();
    return () => {
      cancelled = true;
    };
    // onViewLoaded 由父组件按行生成；只在审批身份变化或重试时重新拉取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, approvalId, attempt]);

  const reveal = async () => {
    setRevealing(true);
    setError(null);
    try {
      const r = await fetch(inputUrl(tenantId, approvalId, true), { method: 'POST' });
      const body = (await r.json().catch(() => ({}))) as GuardApprovalInput & { error?: string };
      if (!r.ok) {
        setError(revealErrorText(t, body.error));
        // 审批已不再待审 / 输入已不可用：手里的视图已过时，重新拉取，收件箱在此期间禁用批准 / 拒绝
        if (body.error === 'approval_not_pending' || body.error === 'input_not_available') {
          reload();
        }
        return;
      }
      setView(body);
      onViewLoaded(body);
      setConfirming(false);
    } catch {
      setError(t('input.errors.generic'));
    } finally {
      setRevealing(false);
    }
  };

  if (failed) {
    return (
      <div className="flex items-center gap-2 text-sm" data-testid="input-failed">
        <Alert variant="danger">{t('input.loadFailed')}</Alert>
        <Button size="sm" variant="secondary" onClick={reload}>{t('input.retry')}</Button>
      </div>
    );
  }
  if (view === undefined) {
    return <p className="text-sm text-fg-muted" data-testid="input-loading">{t('input.loading')}</p>;
  }
  if (view === null) {
    return <Alert variant="warning" data-testid="input-status">{t('input.status.unavailable')}</Alert>;
  }
  const hasDeclaredPii = (view.piiMarks ?? []).length > 0 && hasMaskedPii(view.input);
  const showReveal = canReveal && view.status === 'available' && hasDeclaredPii && !view.revealed;

  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="approval-input-panel">
      <Banners view={view} t={t} />
      {view.status === 'available' && view.input && (
        <ul className="flex flex-col gap-1">
          {Object.entries(view.input).map(([k, v]) => (
            <Node key={k} name={k} value={v} path={k} view={view} t={t} />
          ))}
        </ul>
      )}
      {showReveal && !confirming && (
        <div>
          <Button size="sm" variant="secondary" onClick={() => setConfirming(true)}>{t('input.reveal')}</Button>
        </div>
      )}
      {showReveal && confirming && (
        <div role="alertdialog" aria-label={t('input.reveal')} className="rounded border border-border p-3">
          <p>{t('input.revealConfirm')}</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="primary" onClick={reveal} disabled={revealing}>{t('input.revealConfirmButton')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={revealing}>{t('cancel')}</Button>
          </div>
        </div>
      )}
      {error && <Alert variant="danger">{error}</Alert>}
    </div>
  );
}
