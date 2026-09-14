'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
 * <h2>★队列由**服务端**算，本组件不碰引擎</h2>
 *
 * <p>本组件**不得**直接 import `@aster-cloud/aster-lang-ts`：引擎求
 * contentHash 依赖 `node:crypto`，webpack 不会把 `node:` 方案打进客户端包，
 * 页面会直接 500。注意单测挡不住这类回归——mock 掉引擎模块后一切照常绿。
 *
 * <p>GET `/api/policies/:id/review` 一次返回 `items` + `counts` + `proofs`。
 * 由服务端算 contentHash 也更可信：它是 Proof 的时效性判据，
 * 不该由客户端自报。
 *
 * <h2>★自隐藏</h2>
 *
 * 与 `ShareWithTeamsCard` 同范式：无权查看时 `return null`，
 * 而不是渲染一个"你没有权限"的空壳——后者会让不相关的用户每次都看到噪声。
 */

/** 与服务端同一条规则——只查长度会放行 `'z'.repeat(64)` 这类非十六进制串。 */
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;

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
  readonly items?: readonly ReviewItem[];
  /** 队列是否**真的算出来了**。缺省视为不可用——旧服务端不返回此字段。 */
  readonly queueStatus?: 'ok' | 'engine_outdated' | 'engine_error';
  readonly counts?: { readonly verified: number; readonly reviewRequired: number;
                      readonly rejected: number };
  readonly canReview: boolean;
  readonly subjectKind: string | null;
  readonly proofs: readonly ProofRow[];
}

export interface PolicyReviewPanelProps {
  readonly policyId: string;
}

export function PolicyReviewPanel({ policyId }: PolicyReviewPanelProps) {
  // ★命名空间是**顶层** `policyReview`（同级：whatIf / evidenceExport /
  //   conditionFunnel，见 demo-supplement.ts），不是 `demoPage.policyReview`。
  //   前缀写错时 next-intl 不抛错，getMessageFallback 会把整串 key 原样显示，
  //   界面上每个词都变成 "demoPage.policyReview.accept"。
  //   单测同样挡不住——它把 useTranslations mock 成 key 直返，前缀不参与断言。
  const t = useTranslations('policyReview');

  const [api, setApi] = useState<ReviewApiResponse | null>(null);
  const [items, setItems] = useState<readonly ReviewItem[]>([]);
  const [counts, setCounts] = useState({ verified: 0, reviewRequired: 0, rejected: 0 });
  const [loadError, setLoadError] = useState(false);
  /** 队列不可用（引擎挂了/版本过旧）——必须与"没有待复核项"区分开。 */
  const [queueUnavailable, setQueueUnavailable] = useState(false);
  const [visible, setVisible] = useState<boolean | null>(null);

  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busyNode, setBusyNode] = useState<string | null>(null);
  /**
   * 正在提交的节点——**同步**判据，用于挡住重复提交。
   *
   * <p>★不能只靠 `busyNode` 状态：`setBusyNode` 是异步的，两次快速点击
   * 会在同一轮里都读到旧值（null）并双双放行。表是 append-only，
   * 重复提交＝审计表里留下两条永久 Proof；若先点"拒绝"再点"确认"，
   * 最终有效结论取决于哪个响应先回来——**非确定性**。
   */
  const inFlight = useRef<Set<string>>(new Set());
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** 出错的是哪一条——错误提示要贴着它渲染，而不是丢在卡片底部。 */
  const [errorNode, setErrorNode] = useState<string | null>(null);

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
      const payload = (await res.json()) as ReviewApiResponse;
      setApi(payload);
      // ★仍在此处过滤缺 contentHash 的候选。服务端已过滤一次，这里是第二道：
      //   渲染一条签不下去的候选，用户点了才发现被 400 拒——这种体验必须避免。
      setItems(
        (payload.items ?? []).filter(
          (v) => typeof v.contentHash === 'string' && CONTENT_HASH_RE.test(v.contentHash),
        ),
      );
      setCounts(payload.counts ?? { verified: 0, reviewRequired: 0, rejected: 0 });
      // ★"引擎没跑出来" ≠ "没有待复核项"。后者是结论，前者是**没有结论**。
      //   显示成同一个样子，等于告诉审计员"都查过了"——而实际没查。
      setQueueUnavailable(payload.queueStatus !== 'ok');
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

  /** 每个节点的**当前有效结论**：取最新一条（resolveEffective 的 UI 侧对应）。 */
  const effectiveByNode = useMemo(() => {
    const m = new Map<string, ProofRow>();
    for (const p of api?.proofs ?? []) {
      // proofs 已按 createdAt desc 返回，首次遇到即最新。
      if (!m.has(p.nodeId)) m.set(p.nodeId, p);
    }
    return m;
  }, [api]);

  /**
   * 要单独展示的已落库结论：**不在当前队列里**的那些节点。
   *
   * <p>队列里的节点，其结论已经画在条目内部（带 staleNote 等上下文）；
   * 队列外的节点此前**根本没有出口**——只有队列为空时才显示，
   * 于是「队列非空」时这些结论就整片消失了。
   * 而机器证明过、或已被人拒绝的节点本来就不会进队列，
   * 它们恰恰是最常见的一类。
   */
  /**
   * 每个节点**被覆盖**的结论条数（总数 - 1，当前有效的那条不算）。
   *
   * <p>撤销＝追加一条新 Proof，旧的仍留在表里。审计界面应当说明
   * "这条不是唯一的结论"，否则读者会以为它从一开始就是这样。
   */
  const supersededCount = useMemo(() => {
    const n = new Map<string, number>();
    for (const p of api?.proofs ?? []) n.set(p.nodeId, (n.get(p.nodeId) ?? 0) + 1);
    return n;
  }, [api]);

  const recordedProofs = useMemo(() => {
    const inQueue = new Set(items.map((i) => i.nodeId));
    return Array.from(effectiveByNode.values()).filter((p) => !inQueue.has(p.nodeId));
  }, [effectiveByNode, items]);

  const submit = async (item: ReviewItem, verdict: 'VERIFIED' | 'REJECTED') => {
    const reason = (reasons[item.nodeId] ?? '').trim();
    if (!reason) {
      // ★前端也拦一道：没有理由的批准等于没有复核。
      //   服务端同样强制（两处都要，前端给即时反馈，服务端才是权威）。
      setSubmitError(t('reasonRequired'));
      setErrorNode(item.nodeId);
      return;
    }
    // ★同步守卫必须在任何 await 之前。
    if (inFlight.current.has(item.nodeId)) return;
    inFlight.current.add(item.nodeId);

    setBusyNode(item.nodeId);
    setSubmitError(null);
    setErrorNode(null);
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
        setErrorNode(item.nodeId);
        return;
      }
      setReasons((r) => ({ ...r, [item.nodeId]: '' }));
      await load();
    } catch {
      setSubmitError(t('submitFailed'));
      setErrorNode(item.nodeId);
    } finally {
      inFlight.current.delete(item.nodeId);
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
            {/* ★不要写成 `counts.reviewRequired + items.length`。
                counts 与 items 现在同源（都来自服务端的同一次 bridge 运行），
                相加即**双计**。此前相加是因为服务端不知道队列。 */}
            <Badge>{t('reviewRequired')}: {counts.reviewRequired}</Badge>
            <Badge>{t('rejected')}: {counts.rejected}</Badge>
          </div>

          {api?.canReview === false ? (
            // ★看得见 ≠ 能签字。拥有者若未被授予资格，这里会显示提示，
            //   且下方不渲染任何提交控件——与服务端的 403 一致。
            <p className="text-xs text-fg-subtle">{t('notReviewer')}</p>
          ) : null}

          {items.length === 0 && loadError ? (
            // 加载本身失败时**不显示任何队列结论**：说"没有待复核项"
            // 等于替一次根本没发生的检查背书。上面的 loadFailed 已经说明情况。
            null
          ) : items.length === 0 ? (
            queueUnavailable ? (
              // 不可用时说"不可用"，别说"没有待复核项"。
              <p className="text-sm text-warning" role="status">{t('queueUnavailable')}</p>
            ) : (
              <p className="text-sm text-fg-muted">{t('empty')}</p>
            )
          ) : null}

          {/* ★已落库的结论必须**独立于候选队列**渲染。
              若只画在 `items.map` 内部，队列为空时（引擎不可用正是这种情况）
              一条结论都看不见——而"引擎挂了仍能看已有结论"正是降级的全部意义。 */}
          {recordedProofs.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium text-fg">{t('recordedTitle')}</h3>
              <ul className="flex flex-col gap-2">
                {recordedProofs.map((pr) => (
                  <li key={pr.id} className="rounded-md border border-border p-3">
                    <code className="text-sm text-fg break-all">{pr.text}</code>
                    <p className="text-xs text-fg-muted">
                      {t('recordedBy')}: {pr.subjectUserId} — {pr.verdict}
                    </p>
                    <p className="text-xs text-fg-subtle">{pr.reason}</p>
                    {(supersededCount.get(pr.nodeId) ?? 1) > 1 ? (
                      // 同一节点还有更早的结论被它覆盖——说明这条是修订后的判断。
                      <p className="text-xs text-fg-subtle">{t('supersededNote')}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {items.length > 0 ? (
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

                      {/* ★必须是显式 `=== true`。用真值判断的话，服务端返回的
                          body 缺 `canReview` 字段时（旧服务端、部分失败、字段改名）
                          会给**所有人**渲染提交控件。默认应当是"不能签"。 */}
                      {api?.canReview === true ? (
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
                          {submitError && errorNode === item.nodeId ? (
                            // ★错误必须贴着**出错的那一条**渲染。
                            //   挂在卡片底部的话，队列一长就滚出视口：用户点了
                            //   第 1 条的"确认"却看不到任何反馈，像是没反应。
                            <p className="text-xs text-danger" role="alert">{submitError}</p>
                          ) : null}
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
          ) : null}

        </Stack>
      </CardBody>
    </Card>
  );
}
