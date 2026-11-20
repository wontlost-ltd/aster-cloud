'use client';

/**
 * 确认孤儿的对话框（ADR 0061 §3.3）：唯一的写操作，OPEN → ACKNOWLEDGED，不可撤销且入链。
 *
 * 行内「确认」打开本对话框（第一步），填写说明后点「永久确认」（第二步）才提交。说明去首尾空白后 1–1000 字符
 * 才可提交（与 BFF / aster-api 的校验一致）。可自动解除的类别允许确认，但额外提示「此类会自动解除」（ADR 0061 Q7）。
 * 结果交给调用方：确认成功、409 已不是 OPEN（带当前状态）、403 权限已变化；其余错误留在对话框内按错误码本地化。
 */
import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, Button, Label, Textarea } from '@/components/ui';
import { isAutoResolvable, ORPHAN_STATUSES } from '@/lib/guard-reconciliation/kinds';
import { readBffError, type BffError } from '@/lib/guard-reconciliation/ui';
import type { GuardOrphan, GuardOrphanStatus } from '@/services/policy/guard-types';

export const MAX_ACK_COMMENT = 1000;

export type AckResult =
  | { kind: 'acknowledged'; orphan: GuardOrphan }
  | { kind: 'not_open'; status: GuardOrphanStatus }
  | { kind: 'forbidden' };

interface Props {
  tenantId: string;
  orphan: GuardOrphan;
  onDone: (result: AckResult) => void;
  onCancel: () => void;
}

const KNOWN_ERRORS = new Set(['invalid_ack', 'orphan_not_found', 'upstream_unavailable']);

function isStatus(v: unknown): v is GuardOrphanStatus {
  return typeof v === 'string' && (ORPHAN_STATUSES as readonly string[]).includes(v);
}

export function AckDialog({ tenantId, orphan, onDone, onCancel }: Props) {
  const t = useTranslations('guardReconciliation.ack');
  const commentId = useId();
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<BffError | null>(null);

  const length = comment.trim().length;
  const valid = length >= 1 && length <= MAX_ACK_COMMENT;

  const submit = async () => {
    if (!valid) return;
    setSubmitting(true);
    setError(null);
    try {
      const url = `/api/guard-reconciliation/${encodeURIComponent(tenantId)}/orphans/${orphan.id}/ack`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment: comment.trim() }),
      });
      if (res.ok) return onDone({ kind: 'acknowledged', orphan: (await res.json()) as GuardOrphan });
      const err = await readBffError(res);
      if (res.status === 409 && err.error === 'not_open' && isStatus(err.status)) {
        return onDone({ kind: 'not_open', status: err.status });
      }
      // 会话中被降级（或移出团队）：BFF 现查角色后 403，不调用 aster-api
      if (res.status === 403) return onDone({ kind: 'forbidden' });
      setError(err);
    } catch {
      setError({ httpStatus: 0 });
    } finally {
      setSubmitting(false);
    }
  };

  const errorText = (err: BffError) =>
    t(err.error && KNOWN_ERRORS.has(err.error) ? `errors.${err.error}` : 'errors.generic');

  return (
    <div role="dialog" aria-modal="false" aria-labelledby={`${commentId}-title`}
      className="rounded-lg border border-border bg-bg-subtle p-4" data-testid={`ack-dialog-${orphan.id}`}>
      <h3 id={`${commentId}-title`} className="text-sm font-semibold text-fg">{t('title')}</h3>
      <Alert variant="warning" className="mt-3">{t('irreversible')}</Alert>
      {isAutoResolvable(orphan.kind) && (
        <Alert variant="info" className="mt-2" data-testid="ack-auto-resolve-hint">{t('autoResolveHint')}</Alert>
      )}
      <div className="mt-3 flex flex-col gap-1">
        <Label htmlFor={commentId}>{t('commentLabel')}</Label>
        <Textarea id={commentId} rows={3} value={comment} placeholder={t('commentPlaceholder')}
          onChange={(e) => setComment(e.target.value)} disabled={submitting} />
        <span className={`text-xs ${length > MAX_ACK_COMMENT ? 'text-danger' : 'text-fg-muted'}`} data-testid="ack-counter">
          {t('counter', { count: length, max: MAX_ACK_COMMENT })}
        </span>
      </div>
      {error && (
        <Alert variant="danger" className="mt-3">
          {errorText(error)}
          {error.requestId && <span className="ml-1 font-mono text-xs">{t('requestId', { id: error.requestId })}</span>}
        </Alert>
      )}
      <div className="mt-3 flex gap-2">
        <Button variant="destructive" onClick={submit} disabled={!valid || submitting}>
          {submitting ? t('submitting') : t('submit')}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>{t('cancel')}</Button>
      </div>
    </div>
  );
}
