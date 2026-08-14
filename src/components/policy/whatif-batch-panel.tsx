'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, AlertDescription, Button, Card, CardBody, Input, Select, Stack } from '@/components/ui';

/**
 * What-If 影响估算面板（ADR 0034 S4）。
 *
 * <p><b>三条硬约束，都直接来自 §1.1</b>：
 * <ol>
 *   <li><b>窗口口径必须与数字同屏</b>——用户要知道自己看的是哪个总体。
 *       「最近一个月全部 N 条」与「从 200 条里挑出成功的 30 条」是本质不同的东西。</li>
 *   <li><b>拒答不显示任何业务数字</b>——连「已成功 N 条」都不给。
 *       给了用户就会自己算成功率，那正是上一版 Phase 4 的死因。</li>
 *   <li><b>进度只显示已处理数</b>——不显示成功数，否则用户会在批次跑完前
 *       自行推断结论。</li>
 * </ol>
 *
 * <p>文案走 `demo-supplement.ts` 的**本地补充层**（`whatIf.*`），四语齐备。
 * ★不需要跨仓发版：这些是 cloud 前端特有的 UI 文本，不与 aster-api 共享——
 * 放进共享 npm 包会胖化它并引入发版耦合（见 demo-supplement 头注释）。
 * Phase 4 时期的旧键（title/subtitle/changed/…）被复用；
 * 而 positiveRate / confidence* 属于**已废弃的置信度分档**——
 * 新模型 fail-closed，不存在「部分可信」这种中间态。
 */

type BatchStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';

interface BatchState {
  batchId: string;
  status: BatchStatus;
  windowLabel: string;
  windowFrom: string;
  windowTo: string;
  /**
   * 仅 PENDING/RUNNING/COMPLETED 才有。
   *
   * ★拒答态**刻意不下发**（ADR 0034 §1.1）：它与失败条数同屏
   * 即可相减得出成功数——那正是 Phase 4 的死因。所以这里必须是可选的，
   * 声明成必填等于假设一个服务端不会给的字段。
   */
  plannedCount?: number;
  /** 仅 PENDING/RUNNING：已处理条数（成功+失败），★不含成功数 */
  processedCount?: number;
  /** 仅 COMPLETED */
  result?: {
    changed: number;
    newlyApproved: number;
    newlyRejected: number;
    totalSampled: number;
    estimatedValueDelta: number | null;
  };
  /**
   * 仅 FAILED：失败**类别**列表。
   *
   * ★形状是 `[KIND]` 而不是 `{KIND: count}`（ADR 0034 §10.1，方案 B）。
   * §1.1 是**信息流**约束而非「同屏」约束：给了每类条数，用户可以缓存上一次
   * RUNNING 响应的 plannedCount，再与这里的失败条数**跨请求相减**得出成功数——
   * 那正是 Phase 4 的死因，只是分成了两次请求。
   *
   * ★字段名也从 failureReasons 一并改掉：换名让旧客户端**显式失效**，
   * 而不是把数组当对象 Object.entries 遍历、静默渲染出乱码。
   */
  failureKinds?: string[];
  rejected?: boolean;
  expired?: boolean;
}

/**
 * 空窗口：窗口内没有任何可重放的执行。
 *
 * ★服务端用 `FAILED + failureKinds=[]`（空数组）表达——它**不是**拒答：
 * 拒答是「有样本但部分跑不了，剩下的不代表总体」，
 * 空窗口是「压根没有样本」。两者对用户的含义完全不同：
 * 前者要去查数据，后者只需换个时间窗。
 */
function isEmptyWindow(batch: BatchState): boolean {
  return (
    batch.status === 'FAILED' &&
    (!batch.failureKinds || batch.failureKinds.length === 0)
  );
}

const WINDOW_PRESETS = [
  { kind: 'LAST_MONTH', key: 'lastMonth' },
  { kind: 'LAST_QUARTER', key: 'lastQuarter' },
  { kind: 'LAST_HALF_YEAR', key: 'lastHalfYear' },
  { kind: 'LAST_YEAR', key: 'lastYear' },
  { kind: 'CUSTOM', key: 'customRange' },
] as const;

/** 失败分类 → 文案 key。★区分「你的数据」与「服务端繁忙」的语义在文案里。 */
const FAILURE_KEYS: Record<string, string> = {
  TARGET_COMPILE_ERROR: 'failureTargetCompile',
  INPUT_INCOMPATIBLE: 'failureInputIncompatible',
  VOCABULARY_UNAVAILABLE: 'failureVocabulary',
  TIMEOUT: 'failureTimeout',
  THROTTLED: 'failureThrottled',
  UNKNOWN: 'failureUnknown',
};


/** 今天（用户本地时区）的 YYYY-MM-DD，用作自定义窗口的上限。 */
function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function WhatIfBatchPanel({
  policyId,
  baseVersionId,
  targetVersionId,
  /** 租户是否拥有 What-If 权益。false → 入口可见但禁用 + 升级引导（§7.5）。 */
  entitled,
}: {
  policyId: string;
  baseVersionId: string;
  targetVersionId: string;
  entitled: boolean;
}) {
  const t = useTranslations('whatIf');
  const [windowKind, setWindowKind] = useState<string>('LAST_MONTH');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [batch, setBatch] = useState<BatchState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyBatchId, setBusyBatchId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isRunning = batch?.status === 'PENDING' || batch?.status === 'RUNNING';

  /**
   * 轮询间隔随规模自适应（§7.4）：小批次 1s，万条以上 5s，
   * 避免大批次时把查询端点打爆。
   */
  const pollInterval = (planned: number) => (planned >= 10_000 ? 5_000 : 1_000);

  const fetchBatch = useCallback(
    async (id: string) => {
      const res = await fetch(`/api/v1/policies/${policyId}/whatif-batches/${id}`);
      if (!res.ok) {
        setError(t('loadFailed'));
        return null;
      }
      const data = (await res.json()) as BatchState;
      setBatch(data);
      return data;
    },
    [policyId],
  );

  // 轮询：批次进行中时按规模自适应间隔拉取
  useEffect(() => {
    if (!batch || !isRunning) return;
    pollRef.current = setTimeout(() => {
      void fetchBatch(batch.batchId);
      // 进行中一定有 plannedCount（服务端在 PENDING/RUNNING 下发它）；
      // 真缺失时按最小规模轮询，宁可多拉几次也不要卡住不刷新。
    }, pollInterval(batch.plannedCount ?? 0));
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [batch, isRunning, fetchBatch]);

  const start = async () => {
    setError(null);
    setBusyBatchId(null);
    setStarting(true);
    try {
      const res = await fetch(`/api/v1/policies/${policyId}/whatif-batches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseVersionId,
          targetVersionId,
          windowKind,
          customFrom: windowKind === 'CUSTOM' ? customFrom : undefined,
          customTo: windowKind === 'CUSTOM' ? customTo : undefined,
        }),
      });

      if (res.status === 403) {
        // 无权益——引导升级，不是「稍后再试」
        setError(t('needsPro'));
        return;
      }
      if (res.status === 409) {
        // 已有批次在跑——给出当前批次，让用户能看进度而不是干等
        const body = await res.json();
        setBusyBatchId(body.currentBatchId ?? null);
        setError(t('alreadyRunning'));
        if (body.currentBatchId) void fetchBatch(body.currentBatchId);
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message ?? t('startFailed'));
        return;
      }
      setBatch((await res.json()) as BatchState);
    } finally {
      setStarting(false);
    }
  };

  // ── free 租户：入口可见但禁用 + 升级引导（§7.5）────────────────────
  if (!entitled) {
    return (
      <Card>
        <CardBody>
          <Stack gap={3}>
            <h3 className="text-base font-semibold">{t('title')}</h3>
            <p className="text-sm text-muted-foreground">
              {t('entitlementHint')}
            </p>
            <Alert>
              <AlertDescription>
                {/* ★不给试用额度、不给样例数字——否则 §1.1 会在营销路径上被绕过 */}
                {t('needsPro')}
              </AlertDescription>
            </Alert>
            <Button disabled>{t('run')}</Button>
          </Stack>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody>
        <Stack gap={4}>
          <div>
            <h3 className="text-base font-semibold">{t('title')}</h3>
            <p className="text-sm text-muted-foreground">
              {t('subtitle')}
            </p>
          </div>

          {/* ── 窗口选择 ─────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{t('window')}</span>
              {/* ★用设计系统 Select 而非裸 <select>：原先的
                  `rounded border px-2 py-1` 不带任何颜色 token，
                  在同一面板里与版本对比的两个 select 明显不一致
                  （实测：透明背景 / 近黑边框 / 圆角 4px / 矮 8px）。 */}
              <Select
                size="md"
                value={windowKind}
                onChange={(e) => setWindowKind(e.target.value)}
                disabled={isRunning || starting}
              >
                {WINDOW_PRESETS.map((p) => (
                  <option key={p.kind} value={p.kind}>
                    {t(p.key)}
                  </option>
                ))}
              </Select>
            </label>

            {windowKind === 'CUSTOM' && (
              <>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">{t('from')}</span>
                  <Input
                    type="date"
                    size="md"
                    value={customFrom}
                    max={todayISO()}
                    onChange={(e) => setCustomFrom(e.target.value)}
                    disabled={isRunning || starting}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">{t('to')}</span>
                  <Input
                    type="date"
                    size="md"
                    value={customTo}
                    /* ★前端 max 只是体验；服务端独立拒绝未来日期（§7.1） */
                    max={todayISO()}
                    onChange={(e) => setCustomTo(e.target.value)}
                    disabled={isRunning || starting}
                  />
                </label>
              </>
            )}

            <Button onClick={() => void start()} disabled={isRunning || starting}>
              {starting ? t('starting') : t('run')}
            </Button>
          </div>

          {error && (
            <Alert>
              <AlertDescription>
                {error}
                {busyBatchId && (
                  <span className="ml-1 text-muted-foreground">
                    (batch {busyBatchId.slice(0, 8)})
                  </span>
                )}
              </AlertDescription>
            </Alert>
          )}

          {/* ── 进行中：只显示已处理数，★不显示成功数（§7.4）────────── */}
          {batch && isRunning && (
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span>
                  {t('replaying', { window: batch.windowLabel })}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {batch.processedCount ?? 0} / {batch.plannedCount}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded bg-muted">
                <div
                  className="h-full bg-primary transition-[width]"
                  style={{
                    width: `${
                      batch.plannedCount && batch.plannedCount > 0
                        ? Math.min(100, ((batch.processedCount ?? 0) / batch.plannedCount) * 100)
                        : 0
                    }%`,
                  }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {t('progressHint')}
              </p>
            </div>
          )}

          {/* ── 完成：数字必须与窗口口径同屏（§1.1）──────────────────── */}
          {batch?.status === 'COMPLETED' && batch.result && (
            <div className="space-y-3">
              <p className="text-sm">
                {t('basedOn', {
                  count: batch.result.totalSampled,
                  window: batch.windowLabel,
                })}
              </p>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <Metric label={t('changed')} value={batch.result.changed} />
                <Metric label={t('newlyApproved')} value={batch.result.newlyApproved} />
                <Metric label={t('newlyRejected')} value={batch.result.newlyRejected} />
              </div>
              <p className="text-sm">
                {t('valueImpact')}:{' '}
                {batch.result.estimatedValueDelta === null ? (
                  // ★「无法估算」≠「估算为零」——不得渲染成 0
                  <span className="text-muted-foreground">
                    {t('valueUnavailable')}
                  </span>
                ) : (
                  <strong className="tabular-nums">{batch.result.estimatedValueDelta}</strong>
                )}
              </p>
            </div>
          )}

          {/* ★空窗口 ≠ 拒答：这段时间内该策略就是没有执行，不是「数据有问题」。
              说成「有部分执行无法重跑」会把用户支去排查并不存在的故障——
              这与 §1.1 要防的「用不实的说法解释数字」是同一类不诚实。
              服务端以 FAILED + 空 failureKinds 数组表达这种情况。 */}
          {batch?.status === 'FAILED' && isEmptyWindow(batch) && (
            <Alert>
              <AlertDescription>
                {t('emptyWindow', { window: batch.windowLabel })}
              </AlertDescription>
            </Alert>
          )}

          {/* ── 拒答：★零业务数字，只给失败原因（§1.1）──────────────── */}
          {batch?.status === 'FAILED' && !isEmptyWindow(batch) && (
            <Alert>
              <AlertDescription>
                <Stack gap={2}>
                  <span>
                    {t('rejectedTitle', { window: batch.windowLabel })}{' '}
                    {t('rejectedNote')}
                  </span>
                  {/* ★只列**类别**，不列每类条数（ADR 0034 §10.1）。
                      条数与用户缓存的上一次 plannedCount 相减即得成功数——
                      §1.1 是信息流约束，跨请求相减同样算泄漏。 */}
                  {batch.failureKinds && batch.failureKinds.length > 0 && (
                    <ul className="list-disc pl-5 text-sm">
                      {batch.failureKinds.map((kind) => (
                        <li key={kind}>
                          {FAILURE_KEYS[kind] ? t(FAILURE_KEYS[kind]) : kind}
                        </li>
                      ))}
                    </ul>
                  )}
                </Stack>
              </AlertDescription>
            </Alert>
          )}

          {batch?.status === 'EXPIRED' && (
            <Alert>
              <AlertDescription>
                {t('expired')}
              </AlertDescription>
            </Alert>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
