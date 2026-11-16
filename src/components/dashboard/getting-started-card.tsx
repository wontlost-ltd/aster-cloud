'use client';

/*
 * 上手清单（#796）：仪表盘首屏给每个用户的「下一步」卡片。由原 admin 启动板扩展而来：
 *   - 平台管理员保留原来的五项（策略、API key、AI key、邀请成员、账单）；
 *   - 普通用户是自己的第一步：建策略、运行、加入或组建团队、提交审批，外加可选的「连接 Guard」；
 *   - 原注册后的两步偏好向导并入这里，成为可选的「偏好」条目，就地展开填写。
 *
 * 条目与完成状态由服务端按当前用户的真实数据算好传入（lib/onboarding/getting-started.ts），
 * 本组件只负责渲染、收起与偏好表单。
 *
 * 显示规则：
 *   - 必做条目全部完成即不渲染；可选条目不计入进度，也不阻止隐藏。
 *   - 「收起」按用户记在 localStorage（boolean-preference），同一浏览器换账号互不影响；
 *     管理员此前收起过旧启动板（aster.admin.launchpad.dismissed）的，继续视为已收起，不再弹出。
 *   - 收起状态服务端读不到：水合期间按未收起渲染（与 SSR 一致），水合后才隐藏（#774 #418）。
 *
 * 完成的条目仍保留入口按钮，卡片兼作常用设置页的快捷导航。
 */

import { useEffect, useId, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  BookOpen,
  Check,
  CreditCard,
  FileCheck2,
  KeyRound,
  Play,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { createBooleanPreference, ONE_ZERO, useBooleanPreference } from '@/lib/preferences/boolean-preference';
import { Link } from '@/i18n/navigation';
import { DocsLink } from '@/components/docs/docs-link';
import {
  summarizeGettingStarted,
  type GettingStartedItem,
  type GettingStartedItemId,
} from '@/lib/onboarding/getting-started';
import { Alert, Badge, Button, Card, CardBody, Stack, buttonVariants, cn } from '@/components/ui';

/** 旧 admin 启动板的收起键：已上线、存的是 '1'，只读不写。 */
const LEGACY_ADMIN_DISMISS = createBooleanPreference('aster.admin.launchpad.dismissed', false, ONE_ZERO);

const ICONS: Record<GettingStartedItemId, LucideIcon> = {
  preferences: SlidersHorizontal,
  createPolicy: Plus,
  runPolicy: Play,
  joinTeam: Users,
  submitApproval: FileCheck2,
  connectGuard: ShieldCheck,
  addApiKey: KeyRound,
  addAiKey: Sparkles,
  inviteTeam: Users,
  reviewBilling: CreditCard,
};

/** 管理员条目沿用 adminLaunchpad 已有文案；其余用 gettingStarted 命名空间。 */
const ADMIN_COPY = new Set<GettingStartedItemId>(['addApiKey', 'addAiKey', 'inviteTeam', 'reviewBilling']);

const USE_CASE_IDS = ['finance', 'healthcare', 'ecommerce', 'insurance', 'legal', 'other'] as const;
const GOAL_IDS = ['pii', 'compliance', 'automation', 'team', 'integration'] as const;

export interface GettingStartedCardProps {
  userId: string;
  isAdmin: boolean;
  items: GettingStartedItem[];
}

export function GettingStartedCard({ userId, isAdmin, items }: GettingStartedCardProps) {
  const t = useTranslations('gettingStarted');
  const tAdmin = useTranslations('adminLaunchpad');
  const dismissPref = useMemo(
    () => createBooleanPreference(`aster.gettingStarted.dismissed.${userId}`, false, ONE_ZERO),
    [userId],
  );
  const { value: dismissed, setValue: setDismissed } = useBooleanPreference(dismissPref);
  const { value: legacyDismissed } = useBooleanPreference(LEGACY_ADMIN_DISMISS);
  const [prefsOpen, setPrefsOpen] = useState(false);
  // 偏好保存成功后在服务端刷新前先本地标记完成，避免勾选闪回
  const [prefsSaved, setPrefsSaved] = useState(false);
  const prefsPanelId = useId();

  const shown = items.map((i) => (i.id === 'preferences' && prefsSaved ? { ...i, done: true } : i));
  const { done, total, complete } = summarizeGettingStarted(shown);
  if (complete || dismissed || (isAdmin && legacyDismissed)) return null;

  const copy = (id: GettingStartedItemId, field: 'label' | 'desc' | 'cta') =>
    ADMIN_COPY.has(id) || (isAdmin && id === 'createPolicy') ? tAdmin(`steps.${id}.${field}`) : t(`steps.${id}.${field}`);

  return (
    <Card data-testid="getting-started-card">
      <CardBody className="pt-6">
        <Stack gap={5}>
          <Stack direction="row" justify="between" align="start" gap={3} wrap>
            <Stack gap={1} className="min-w-0 flex-1">
              <Stack direction="row" gap={2} align="center" wrap>
                <h2 className="font-display text-xl font-semibold tracking-tight text-fg">
                  {isAdmin ? tAdmin('title') : t('title')}
                </h2>
                <Badge variant="primary">{tAdmin('progress', { done, total })}</Badge>
              </Stack>
              <p className="text-sm text-fg-muted">{isAdmin ? tAdmin('body') : t('body')}</p>
            </Stack>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="rounded-md px-2 py-1 text-xs text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:shadow-ring"
            >
              {tAdmin('dismiss')}
            </button>
          </Stack>

          <ol className="flex flex-col gap-3">
            {shown.map((item) => {
              const Icon = ICONS[item.id];
              const label = copy(item.id, 'label');
              return (
                <li
                  key={item.id}
                  data-testid={`getting-started-${item.id}`}
                  data-done={item.done ? 'true' : 'false'}
                  className={cn('rounded-md border border-border p-3', item.done ? 'bg-success-subtle' : 'bg-bg')}
                >
                  <div className="flex flex-wrap items-start gap-3 sm:flex-nowrap">
                    <span
                      className={cn(
                        'mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full border',
                        item.done ? 'border-success bg-success text-success-fg' : 'border-border bg-bg-subtle text-fg-muted',
                      )}
                      aria-hidden
                    >
                      {item.done ? <Check className="size-4" /> : <Icon className="size-4" />}
                    </span>
                    <Stack gap={1} className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
                        <span className={cn(item.done && 'text-success line-through')}>{label}</span>
                        {item.done && <span className="sr-only">{t('doneLabel')}</span>}
                        {item.optional && <Badge variant="neutral">{t('optional')}</Badge>}
                      </p>
                      <p className="text-sm text-fg-muted">{copy(item.id, 'desc')}</p>
                    </Stack>
                    <ItemAction
                      item={item}
                      cta={item.id === 'preferences' && item.done ? t('steps.preferences.ctaDone') : copy(item.id, 'cta')}
                      prefsOpen={prefsOpen}
                      prefsPanelId={prefsPanelId}
                      onTogglePrefs={() => setPrefsOpen((v) => !v)}
                    />
                  </div>
                  {item.id === 'preferences' && prefsOpen && (
                    <PreferencesForm
                      id={prefsPanelId}
                      hasSaved={item.done}
                      onCancel={() => setPrefsOpen(false)}
                      onSaved={() => {
                        setPrefsSaved(true);
                        setPrefsOpen(false);
                      }}
                    />
                  )}
                </li>
              );
            })}
          </ol>
        </Stack>
      </CardBody>
    </Card>
  );
}

function ItemAction({
  item,
  cta,
  prefsOpen,
  prefsPanelId,
  onTogglePrefs,
}: {
  item: GettingStartedItem;
  cta: string;
  prefsOpen: boolean;
  prefsPanelId: string;
  onTogglePrefs: () => void;
}) {
  const className = cn(buttonVariants({ variant: item.done ? 'secondary' : 'primary', size: 'sm' }), 'shrink-0 max-sm:ml-10');
  const action = item.action;
  if (action.kind === 'preferences') {
    return (
      <button type="button" className={className} aria-expanded={prefsOpen} aria-controls={prefsPanelId} onClick={onTogglePrefs}>
        {cta}
      </button>
    );
  }
  if (action.kind === 'docs') {
    return (
      <DocsLink slug={action.slug} className={className}>
        <BookOpen className="size-4" aria-hidden />
        {cta}
      </DocsLink>
    );
  }
  return (
    <Link href={action.href} className={className}>
      {cta}
    </Link>
  );
}

/**
 * 原两步向导的内容（行业 + 目标），并为卡片内的一个小表单。保存到 /api/user/onboarding（与旧向导同一接口、同一列），
 * 成功后刷新服务端数据，使「偏好」条目按真实状态打勾。
 */
function PreferencesForm({
  id,
  hasSaved,
  onCancel,
  onSaved,
}: {
  id: string;
  /** 已保存过偏好：先读出原值再允许保存 */
  hasSaved: boolean;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('gettingStarted.preferences');
  const tOnboarding = useTranslations('auth.onboarding');
  const tCommon = useTranslations('common');
  const router = useRouter();
  const [useCase, setUseCase] = useState('');
  const [goals, setGoals] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  // 修改已保存的偏好时先带出原值：接口整体覆盖行业与目标，空白表单直接保存会清掉原来的目标。
  // 读不到原值（失败）时不允许保存，宁可让用户稍后再改，也不覆盖已有数据；首次填写没有原值，无需读取。
  const [prefill, setPrefill] = useState<'loading' | 'ready' | 'failed'>(hasSaved ? 'loading' : 'ready');
  useEffect(() => {
    if (!hasSaved) return;
    let cancelled = false;
    fetch('/api/user/onboarding')
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<{ useCase?: string | null; goals?: string[] | null }>;
      })
      .then((saved) => {
        if (cancelled) return;
        if (saved.useCase) setUseCase((cur) => cur || saved.useCase!);
        if (Array.isArray(saved.goals) && saved.goals.length > 0) setGoals((cur) => (cur.length ? cur : saved.goals!));
        setPrefill('ready');
      })
      .catch(() => {
        if (!cancelled) setPrefill('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [hasSaved]);
  const useCaseLegend = useId();
  const goalsLegend = useId();

  const toggleGoal = (goal: string) =>
    setGoals((prev) => (prev.includes(goal) ? prev.filter((g) => g !== goal) : [...prev, goal]));

  const [needsUseCase, setNeedsUseCase] = useState(false);

  const save = async () => {
    if (prefill !== 'ready') return;
    // 不用禁用按钮表达「先选行业」：禁用控件不可聚焦、也不说明原因，改为点击后就地提示
    if (!useCase) {
      setNeedsUseCase(true);
      return;
    }
    setSaving(true);
    setFailed(false);
    try {
      const res = await fetch('/api/user/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useCase, goals }),
      });
      if (!res.ok) throw new Error(String(res.status));
      onSaved();
      router.refresh();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const chip = (selected: boolean) =>
    cn(
      'rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:shadow-ring',
      selected ? 'border-primary bg-primary-subtle text-fg' : 'border-border bg-bg text-fg hover:border-border-strong',
    );

  return (
    <div id={id} className="mt-4 border-t border-border pt-4 sm:ml-10" data-testid="getting-started-preferences-form">
      <Stack gap={4}>
        <div role="group" aria-labelledby={useCaseLegend}>
          <p id={useCaseLegend} className="mb-2 text-sm font-medium text-fg">{tOnboarding('industryQuestion')}</p>
          <div className="flex flex-wrap gap-x-2 gap-y-3">
            {USE_CASE_IDS.map((u) => (
              <button key={u} type="button" aria-pressed={useCase === u} className={chip(useCase === u)} onClick={() => {
                  setUseCase(u);
                  setNeedsUseCase(false);
                }}>
                {tOnboarding(`useCases.${u}`)}
              </button>
            ))}
          </div>
        </div>
        <div role="group" aria-labelledby={goalsLegend}>
          <p id={goalsLegend} className="mb-2 text-sm font-medium text-fg">{tOnboarding('goalsQuestion')}</p>
          <div className="flex flex-wrap gap-x-2 gap-y-3">
            {GOAL_IDS.map((g) => (
              <button key={g} type="button" aria-pressed={goals.includes(g)} className={chip(goals.includes(g))} onClick={() => toggleGoal(g)}>
                {tOnboarding(`goals.${g}`)}
              </button>
            ))}
          </div>
        </div>
        {needsUseCase && <p role="alert" className="text-sm text-danger">{t('chooseIndustry')}</p>}
        {prefill === 'failed' && <Alert variant="danger">{t('loadFailed')}</Alert>}
        {failed && <Alert variant="danger">{t('saveFailed')}</Alert>}
        <Stack direction="row" gap={3} wrap>
          <Button size="sm" variant="primary" onClick={save} disabled={saving}>
            {saving ? t('saving') : t('save')}
          </Button>
          <Button size="sm" variant="secondary" onClick={onCancel}>
            {tCommon('cancel')}
          </Button>
        </Stack>
      </Stack>
    </div>
  );
}
