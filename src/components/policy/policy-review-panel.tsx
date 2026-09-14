'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Card, CardBody, Label, Stack, buttonVariants, cn } from '@/components/ui';

/**
 * 人工复核面板（ADR 0037 §14/§15）。
 *
 * <h2>三段式里它只负责第③段</h2>
 *
 * <pre>
 *   ① 提出   引擎 / LLM   → 候选（没有判定力）
 *   ② 判定   verifier     → VERIFIED / REVIEW_REQUIRED / REJECTED
 *   ③ 复核   **人**       → Proof  ← 本组件
 * </pre>
 *
 * <h2>★队列在**前端**算，不在服务端</h2>
 *
 * `runSemanticBridge` 是纯函数，跑在边缘运行时既快又省一次往返；
 * 服务端路由只负责「谁能看 / 谁能签」与已落库的结论。
 * 这样也避免把**引擎版本**绑死在服务端——前端用哪版引擎，看到的就是哪版的候选。
 *
 * <h2>★自隐藏</h2>
 *
 * 与 `ShareWithTeamsCard` 同范式：无权查看时 `return null`，
 * 而不是渲染一个"你没有权限"的空壳——后者会让不相关的用户每次都看到噪声。
 */

interface ReviewItem {
  readonly text: string;
  readonly span: { readonly start: number; readonly end: number };
  readonly reason: string;
  readonly nodeId: string;
  /** 该节点当前的内容指纹——提交结论时必须原样带回。 */
  readonly contentHash: string;
}

interface ProofRow {
  readonly id: string;
  readonly nodeId: string;
  readonly contentHash: string;
  readonly verdict: string;
  readonly reason: string;
  readonly subjectKind: string;
  readonly subjectUserId: string;
  readonly text: string;
  readonly span: { readonly start: number; readonly end: number };
  readonly recordedAt: string;
}

interface ReviewApiResponse {
  readonly canReview: boolean;
  readonly subjectKind: string | null;
  readonly proofs: readonly ProofRow[];
}

export interface PolicyReviewPanelProps {
  readonly policyId: string;
  /** 策略源码——用于在前端跑引擎算出候选队列。 */
  readonly source: string;
}

export function PolicyReviewPanel({ policyId, source }: PolicyReviewPanelProps) {
  const t = useTranslations('demoPage.policyReview');

  const [api, setApi] = useState<ReviewApiResponse | null>(null);
  const [items, setItems] = useState<readonly ReviewItem[]>([]);
  const [counts, setCounts] = useState({ verified: 0, reviewRequired: 0, rejected: 0 });
  const [loadError, setLoadError] = useState(false);
  const [visible, setVisible] = useState<boolean | null>(null);

  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busyNode, setBusyNode] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/policies/${policyId}/review`);
      if (res.status === 404 || res.status === 401) {
        // ★无权查看 → 自隐藏（不渲染"没有权限"的空壳）。
        setVisible(false);
        return;
      }
      if (!res.ok) {
        setLoadError(true);
        setVisible(true);
        return;
      }
      setApi((await res.json()) as ReviewApiResponse);
      setVisible(true);
    } catch {
      setLoadError(true);
      setVisible(true);
    }
  }, [policyId]);

  useEffect(() => {
    // 挂载时异步拉取复核状态；setState 发生在 await 之后（数据到达时），
    // 非渲染期同步写入，不会造成级联渲染。属正常数据加载副作用。
    // 与 share-with-teams-card.tsx 同范式。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // ★在前端跑引擎算队列。动态 import：引擎体积不小，
  //   不该拖慢没打开复核面板的用户的首屏。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mod = await import('@aster-cloud/aster-lang-ts');
        const run = (mod as unknown as {
          runSemanticBridge?: (s: string) => {
            verified: readonly {
              mapping: { text: string; nodeId: string; span: { start: number; end: number } };
              result: { verdict: string; reason: string };
              contentHash?: string;
            }[];
            summary: { verified: number; reviewRequired: number; rejected: number };
          };
        }).runSemanticBridge;
        if (!run) return;                       // 引擎版本过旧——静默降级为"只看结论"
        const r = run(source);
        if (cancelled) return;
        setCounts(r.summary);
        setItems(
          r.verified
            .filter((v) => v.result.verdict === 'REVIEW_REQUIRED')
            // ★没有 contentHash 的候选**不能**进队列：提交时服务端会拒
            //   （要求 64 位十六进制），渲染出来只会让人点了才发现签不了。
            //   正常情况下不会发生；真发生了说明引擎版本过旧或路径口径漂移。
            .filter((v) => typeof v.contentHash === 'string' && v.contentHash.length === 64)
            .map((v) => ({
              text: v.mapping.text,
              span: v.mapping.span,
              reason: v.result.reason,
              nodeId: v.mapping.nodeId,
              contentHash: v.contentHash!,
            })),
        );
      } catch {
        // 引擎跑不起来不该让整个面板消失——已落库的结论仍然有价值。
      }
    })();
    return () => { cancelled = true; };
  }, [source]);

  /** 每个节点的**当前有效结论**：取最新一条（resolveEffective 的 UI 侧对应）。 */
  const effectiveByNode = useMemo(() => {
    const m = new Map<string, ProofRow>();
    for (const p of api?.proofs ?? []) {
      // proofs 已按 createdAt desc 返回，首次遇到即最新。
      if (!m.has(p.nodeId)) m.set(p.nodeId, p);
    }
    return m;
  }, [api]);

  const submit = async (item: ReviewItem, verdict: 'VERIFIED' | 'REJECTED') => {
    const reason = (reasons[item.nodeId] ?? '').trim();
    if (!reason) {
      // ★前端也拦一道：没有理由的批准等于没有复核。
      //   服务端同样强制（两处都要，前端给即时反馈，服务端才是权威）。
      setSubmitError(t('reasonRequired'));
      return;
    }
    setBusyNode(item.nodeId);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/policies/${policyId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodeId: item.nodeId,
          contentHash: item.contentHash,
          verdict,
          reason,
          text: item.text,
          span: item.span,
        }),
      });
      if (!res.ok) {
        setSubmitError(t('submitFailed'));
        return;
      }
      setReasons((r) => ({ ...r, [item.nodeId]: '' }));
      await load();
    } catch {
      setSubmitError(t('submitFailed'));
    } finally {
      setBusyNode(null);
    }
  };

  if (visible !== true) return null;

  return (
    <Card className="mt-6">
      <CardBody className="pt-6">
        <Stack gap={4}>
          <div>
            <h2 className="font-display text-xl font-semibold tracking-tight text-fg">
              {t('title')}
            </h2>
            <p className="text-sm text-fg-muted">{t('subtitle')}</p>
          </div>

          {loadError ? (
            <p className="text-sm text-danger" role="alert">{t('loadFailed')}</p>
          ) : null}

          {/* 三类计数——UI 的第一眼信息 */}
          <div className="flex flex-wrap gap-2">
            <Badge>{t('verified')}: {counts.verified}</Badge>
            <Badge>{t('reviewRequired')}: {counts.reviewRequired + items.length}</Badge>
            <Badge>{t('rejected')}: {counts.rejected}</Badge>
          </div>

          {api?.canReview === false ? (
            // ★看得见 ≠ 能签字。拥有者若未被授予资格，这里会显示提示，
            //   且下方不渲染任何提交控件——与服务端的 403 一致。
            <p className="text-xs text-fg-subtle">{t('notReviewer')}</p>
          ) : null}

          {items.length === 0 ? (
            <p className="text-sm text-fg-muted">{t('empty')}</p>
          ) : (
            <ul className="flex flex-col gap-4">
              {items.map((item) => {
                const effective = effectiveByNode.get(item.nodeId);
                const stale = effective && effective.contentHash !== item.contentHash;
                return (
                  <li key={item.nodeId} className="rounded-md border border-border p-3">
                    <Stack gap={2}>
                      <code className="text-sm text-fg break-all">{item.text}</code>
                      <p className="text-xs text-fg-subtle">{item.reason}</p>

                      {effective ? (
                        <p className="text-xs text-fg-muted">
                          {t('recordedBy')}: {effective.subjectUserId} — {effective.verdict}
                          {stale ? ` · ${t('staleNote')}` : ''}
                        </p>
                      ) : null}

                      {api?.canReview ? (
                        <>
                          <Label htmlFor={`reason-${item.nodeId}`}>{t('reasonLabel')}</Label>
                          <textarea
                            id={`reason-${item.nodeId}`}
                            className="w-full rounded-md border border-border bg-bg p-2 text-sm text-fg"
                            rows={2}
                            placeholder={t('reasonPlaceholder')}
                            value={reasons[item.nodeId] ?? ''}
                            onChange={(e) =>
                              setReasons((r) => ({ ...r, [item.nodeId]: e.target.value }))
                            }
                          />
                          <div className="flex gap-2">
                            <button
                              type="button"
                              className={cn(buttonVariants({ size: 'sm' }))}
                              disabled={busyNode === item.nodeId}
                              onClick={() => void submit(item, 'VERIFIED')}
                            >
                              {busyNode === item.nodeId ? t('submitting') : t('accept')}
                            </button>
                            <button
                              type="button"
                              className={cn(buttonVariants({ size: 'sm', variant: 'outline' }))}
                              disabled={busyNode === item.nodeId}
                              onClick={() => void submit(item, 'REJECTED')}
                            >
                              {t('reject')}
                            </button>
                          </div>
                        </>
                      ) : null}
                    </Stack>
                  </li>
                );
              })}
            </ul>
          )}

          {submitError ? (
            <p className="text-xs text-danger" role="alert">{submitError}</p>
          ) : null}
        </Stack>
      </CardBody>
    </Card>
  );
}
